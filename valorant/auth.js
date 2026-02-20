import {
    fetch,
    parseSetCookie,
    stringifyCookies,
    extractTokensFromUri,
    tokenExpiry,
    decodeToken,
    wait
} from "../misc/util.js";
import config from "../misc/config.js";
import {client} from "../discord/bot.js";
import {addUser, deleteUser, getAccountWithPuuid, getUserJson, readUserJson, saveUser} from "./accountSwitcher.js";
import {checkRateLimit, isRateLimited} from "../misc/rateLimit.js";
import {queueCookiesLogin} from "./authQueue.js";
import {waitForAuthQueueResponse} from "../discord/authManager.js";
import {getAllUserIds} from "../misc/userDatabase.js";

// Short-lived cache for getUser() lookups within a single tick/request cycle.
// Call beginUserCacheScope() before a batch of operations, endUserCacheScope() after.
let userCache = null;

export const beginUserCacheScope = () => {
    userCache = new Map();
};

export const endUserCacheScope = () => {
    userCache = null;
};

export class User {
    constructor({id, puuid, auth, alerts=[], username, region, authFailures, lastFetchedData, lastNoticeSeen, lastSawEasterEgg}) {
        this.id = id;
        this.puuid = puuid;
        this.auth = auth;
        this.alerts = alerts || [];
        this.username = username;
        this.region = region;
        this.authFailures = authFailures || 0;
        this.lastFetchedData = lastFetchedData || 0;
        this.lastNoticeSeen =  lastNoticeSeen || "";
        this.lastSawEasterEgg = lastSawEasterEgg || 0;
    }
}

export const getUser = (id, account=null) => {
    if(id instanceof User) {
        const user = id;
        const userJson = readUserJson(user.id);
        if(!userJson) return null;

        const userData = userJson.accounts.find(a => a.puuid === user.puuid);
        return userData && new User(userData);
    }

    // Check short-lived cache if a scope is active
    const cacheKey = `${id}:${account ?? ''}`;
    if (userCache) {
        const cached = userCache.get(cacheKey);
        if (cached !== undefined) return cached;
    }

    try {
        const userData = getUserJson(id, account);
        const result = userData && new User(userData);
        if (userCache) userCache.set(cacheKey, result);
        return result;
    } catch(e) {
        if (userCache) userCache.set(cacheKey, null);
        return null;
    }
}

/**
 * Invalidate a specific user in the cache (call after saveUser or auth changes).
 */
export const invalidateUserCache = (id) => {
    if (!userCache) return;
    for (const key of userCache.keys()) {
        if (key.startsWith(`${id}:`)) userCache.delete(key);
    }
}

export const getUserList = () => {
    const userIds = getAllUserIds();
    console.log(`[getUserList] Retrieved ${userIds.length} users from database`);
    return userIds;
}

export const authUser = async (id, account=null) => {
    // doesn't check if token is valid, only checks it hasn't expired
    const user = getUser(id, account);
    if(!user || !user.auth || !user.auth.rso) return {success: false};

    const rsoExpiry = tokenExpiry(user.auth.rso);
    const timeRemaining = rsoExpiry - Date.now();
    const minutesRemaining = Math.floor(timeRemaining / 60000);
    
    // Check if auto-refresh is enabled
    if(!config.autoRefreshTokens) {
        // No auto-refresh: only check if token is still valid (not expired)
        if(timeRemaining > 0) {
            console.log(`[authUser] Token valid for ${minutesRemaining} more minutes (auto-refresh disabled) (${user.username})`);
            return {success: true};
        }
        console.log(`[authUser] Token expired, cannot proceed (auto-refresh disabled) (${user.username})`);
        return {success: false};
    }
    
    // Auto-refresh enabled: refresh if below buffer threshold
    const bufferMs = (config.tokenRefreshBufferMinutes || 5) * 60 * 1000;
    if(timeRemaining > bufferMs) {
        console.log(`[authUser] Token valid for ${minutesRemaining} more minutes (${user.username})`);
        return {success: true};
    }

    console.log(`[authUser] Token expires in ${minutesRemaining} minutes, refreshing now (${user.username})`);
    return await refreshToken(id, account);
}

const processAuthResponse = async (id, authData, redirect, user=null) => {
    if(!user) user = new User({id});
    const [rso, idt] = extractTokensFromUri(redirect);
    if(rso == null) {
        console.error("Riot servers didn't return an RSO token!");
        console.error("Most likely the Cloudflare firewall is blocking your IP address. Try hosting on your home PC and seeing if the issue still happens.");
        throw "Riot servers didn't return an RSO token!";
    }

    user.auth = {
        ...user.auth,
        rso: rso,
        idt: idt,
        cookies: authData.cookies
    }

    user.puuid = decodeToken(rso).sub;

    const existingAccount = getAccountWithPuuid(id, user.puuid);
    if(existingAccount) {
        user.username = existingAccount.username;
        user.region = existingAccount.region;
        if(existingAccount.auth) user.auth.ent = existingAccount.auth.ent;
    }

    // get username
    const userInfo = await getUserInfo(user);
    user.username = userInfo.username;

    // get entitlements token
    if(!user.auth.ent) user.auth.ent = await getEntitlements(user);

    // get region
    if(!user.region) user.region = await getRegion(user);

    user.lastFetchedData = Date.now();

    user.authFailures = 0;
    return user;
}

export const getUserInfo = async (user) => {
    const req = await fetch("https://auth.riotgames.com/userinfo", {
        headers: {
            'Authorization': "Bearer " + user.auth.rso
        }
    });
    console.assert(req.statusCode === 200, `User info status code is ${req.statusCode}!`, req);

    const json = JSON.parse(req.body);
    if(json.acct) return {
        puuid: json.sub,
        username: json.acct.game_name && json.acct.game_name + "#" + json.acct.tag_line
    }
}

const getEntitlements = async (user) => {
    const req = await fetch("https://entitlements.auth.riotgames.com/api/token/v1", {
        method: "POST",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': "Bearer " + user.auth.rso
        }
    });
    console.assert(req.statusCode === 200, `Auth status code is ${req.statusCode}!`, req);

    const json = JSON.parse(req.body);
    return json.entitlements_token;
}

export const getRegion = async (user) => {
    const req = await fetch("https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant", {
        method: "PUT",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': "Bearer " + user.auth.rso
        },
        body: JSON.stringify({
            'id_token': user.auth.idt,
        })
    });
    console.assert(req.statusCode === 200, `PAS token status code is ${req.statusCode}!`, req);

    const json = JSON.parse(req.body);
    return json.affinities.live;
}

export const redeemCookies = async (id, cookies) => {
    let rateLimit = await isRateLimited("auth.riotgames.com");
    if(rateLimit) return {success: false, rateLimit: rateLimit};

    const req = await fetch("https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&scope=account%20openid&nonce=1", {
        headers: {
            'user-agent': await getUserAgent(),
            cookie: cookies
        }
    });
    console.log(`[redeemCookies] Status: ${req.statusCode}, Location: ${req.headers.location}`);
    console.assert(req.statusCode === 303, `Cookie Reauth status code is ${req.statusCode}!`, req);

    rateLimit = await checkRateLimit(req, "auth.riotgames.com");
    if(rateLimit) return {success: false, rateLimit: rateLimit};

    if(detectCloudflareBlock(req)) return {success: false, rateLimit: "cloudflare"};

    // invalid cookies → Riot redirects to login page (can be relative or full URL)
    if(req.headers.location && (req.headers.location.startsWith("/login") || req.headers.location.includes("authenticate.riotgames.com/login"))) {
        console.log(`[redeemCookies] Cookies are invalid, redirected to login page`);
        return {success: false};
    }

    cookies = {
        ...parseSetCookie(cookies),
        ...parseSetCookie(req.headers['set-cookie'])
    }

    const user = await processAuthResponse(id, {cookies}, req.headers.location);
    addUser(user);

    return {success: true};
}

export const refreshToken = async (id, account=null) => {
    console.log(`Refreshing token for ${id}...`)
    let response = {success: false}

    let user = getUser(id, account);
    if(!user) return response;

    // 1. Try refresh_token first (from code flow / offline_access)
    if(user.auth.refresh_token) {
        console.log(`[refreshToken] User has refresh_token, attempting refresh`);
        try {
            const tokenData = await refreshWithRefreshToken(user.auth.refresh_token);
            if(tokenData && tokenData.access_token) {
                user.auth.rso = tokenData.access_token;
                if(tokenData.id_token) user.auth.idt = tokenData.id_token;
                // Riot may rotate refresh tokens — always store the latest one
                if(tokenData.refresh_token) {
                    user.auth.refresh_token = tokenData.refresh_token;
                    user.auth.refresh_token_obtained = Date.now();
                }
                // Re-fetch entitlements with the new access token
                user.auth.ent = await getEntitlements(user);
                user.lastFetchedData = Date.now();
                user.authFailures = 0;
                saveUser(user);
                
                const newExpiry = tokenExpiry(user.auth.rso);
                const expiresIn = Math.floor((newExpiry - Date.now()) / 60000);
                console.log(`[refreshToken] Refresh token success for ${user.username} — new token expires in ${expiresIn} minutes`);
                return {success: true};
            } else {
                console.log(`[refreshToken] Refresh token failed, token may be revoked`);
                user.auth.refresh_token = null; // clear invalid refresh token
            }
        } catch(e) {
            console.error(`[refreshToken] Error using refresh token:`, e);
            user.auth.refresh_token = null;
        }
    }

    // 2. Fall back to cookie-based refresh
    if(user.auth.cookies) {
        console.log(`[refreshToken] User has cookies, attempting cookie refresh`);
        response = await queueCookiesLogin(id, stringifyCookies(user.auth.cookies));
        if(response.inQueue) response = await waitForAuthQueueResponse(response);
    } else {
        console.log(`[refreshToken] User has no cookies or refresh_token, cannot refresh`);
    }

    if(!response.success && !response.rateLimit) deleteUserAuth(user);

    return response;
}




const getUserAgent = async () => {
    // temporary bypass for Riot adding hCaptcha (see github issue #93)
    return "ShooterGame/13 Windows/10.0.19043.1.256.64bit";
}

const detectCloudflareBlock = (req) => {
    const blocked = req.statusCode === 403 && req.headers["x-frame-options"] === "SAMEORIGIN";

    if(blocked) {
        console.error("[ !!! ] Error 1020: Your bot might be rate limited, it's best to check if your IP address/your hosting service is blocked by Riot - try hosting on your own PC to see if it solves the issue?")
    }

    return blocked;
}

export const deleteUserAuth = (user) => {
    user.auth = null;
    saveUser(user);
}

/**
 * Get token status information for a user
 * Returns: { hasToken, hasRefreshToken, expiresAt, expiresInMinutes, needsRefresh }
 */
export const getTokenStatus = (id, account=null) => {
    const user = getUser(id, account);
    if(!user || !user.auth || !user.auth.rso) {
        return { hasToken: false, hasRefreshToken: false };
    }

    const rsoExpiry = tokenExpiry(user.auth.rso);
    const timeRemaining = rsoExpiry - Date.now();
    const minutesRemaining = Math.floor(timeRemaining / 60000);
    const expiresAt = new Date(rsoExpiry);
    const needsRefresh = timeRemaining <= 30 * 60 * 1000; // Less than 30 minutes

    const status = {
        hasToken: true,
        hasRefreshToken: !!user.auth.refresh_token,
        hasCookies: !!user.auth.cookies,
        expiresAt: expiresAt.toISOString(),
        expiresInMinutes: minutesRemaining,
        needsRefresh: needsRefresh,
        canAutoRefresh: !!user.auth.refresh_token || !!user.auth.cookies
    };

    // Add refresh token age if available
    if (user.auth.refresh_token && user.auth.refresh_token_obtained) {
        const tokenAge = Date.now() - user.auth.refresh_token_obtained;
        const daysOld = Math.floor(tokenAge / (1000 * 60 * 60 * 24));
        const hoursOld = Math.floor((tokenAge % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        status.refreshTokenObtainedAt = new Date(user.auth.refresh_token_obtained).toISOString();
        status.refreshTokenAge = `${daysOld}d ${hoursOld}h`;
    }

    return status;
}

// Web-based OAuth login flow
// Generates an auth URL that user opens in browser, logs in, then pastes the redirect URL back

export const generateWebAuthUrl = () => {
    // Generate a random nonce for security
    const nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    
    const params = new URLSearchParams({
        client_id: "riot-client",
        redirect_uri: "http://localhost/redirect",
        response_type: "code",
        scope: "openid link ban lol_region account offline_access",
        nonce: nonce
    });
    
    return {
        url: `https://auth.riotgames.com/authorize?${params.toString()}`,
        nonce: nonce
    };
}

/**
 * Extract the authorization code from a callback URL.
 * Code flow redirects to: http://localhost/redirect?code=XXXXX
 */
const extractCodeFromUri = (uri) => {
    try {
        const url = new URL(uri);
        return url.searchParams.get("code");
    } catch {
        // Try regex fallback for malformed URLs
        const match = uri.match(/[?&]code=([^&]+)/);
        return match ? match[1] : null;
    }
}

/**
 * Exchange an authorization code for access_token, id_token, and refresh_token
 * via a server-to-server POST to the Riot token endpoint.
 */
const exchangeCodeForTokens = async (code) => {
    const req = await fetch("https://auth.riotgames.com/token", {
        method: "POST",
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'user-agent': await getUserAgent()
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code,
            redirect_uri: "http://localhost/redirect",
            client_id: "riot-client"
        }).toString()
    });

    if (req.statusCode !== 200) {
        console.error(`[exchangeCodeForTokens] Token exchange failed with status ${req.statusCode}:`, req.body);
        return null;
    }

    const json = JSON.parse(req.body);
    // json should contain: access_token, id_token, refresh_token, token_type, expires_in, scope
    // Log available fields (without token values for security)
    const fields = Object.keys(json).filter(k => !k.includes('token') && !k.includes('secret'));
    console.log(`[exchangeCodeForTokens] Response fields: ${fields.join(', ')}`);
    if (json.expires_in) console.log(`[exchangeCodeForTokens] Access token expires in ${json.expires_in} seconds (${Math.floor(json.expires_in / 60)} minutes)`);
    return json;
}

/**
 * Use a refresh token to obtain a new access_token (and possibly a rotated refresh_token).
 * Returns the full token response or null on failure.
 */
export const refreshWithRefreshToken = async (refreshToken) => {
    const req = await fetch("https://auth.riotgames.com/token", {
        method: "POST",
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'user-agent': await getUserAgent()
        },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: "riot-client"
        }).toString()
    });

    if (req.statusCode !== 200) {
        console.error(`[refreshWithRefreshToken] Refresh failed with status ${req.statusCode}:`, req.body);
        return null;
    }

    const json = JSON.parse(req.body);
    // Log available fields to see if Riot returns refresh token expiry info
    const fields = Object.keys(json).filter(k => !k.includes('token') && !k.includes('secret'));
    console.log(`[refreshWithRefreshToken] Response fields: ${fields.join(', ')}`);
    if (json.expires_in) console.log(`[refreshWithRefreshToken] New access token expires in ${json.expires_in} seconds (${Math.floor(json.expires_in / 60)} minutes)`);
    return json;
}

export const redeemWebAuthUrl = async (id, callbackUrl) => {
    try {
        // Extract the authorization code from the callback URL
        const code = extractCodeFromUri(callbackUrl);
        
        if (!code) {
            return { success: false, error: "Could not extract authorization code from URL. Make sure you copied the full URL from the browser address bar." };
        }

        // Exchange the code for tokens server-to-server
        const tokenData = await exchangeCodeForTokens(code);
        if (!tokenData || !tokenData.access_token) {
            return { success: false, error: "Failed to exchange authorization code for tokens. The code may have expired (they are single-use)." };
        }

        const rso = tokenData.access_token;
        const idt = tokenData.id_token;
        const refresh_token = tokenData.refresh_token; // long-lived, from offline_access scope

        // Create a new user with the tokens
        const user = new User({ id });
        user.auth = {
            rso: rso,
            idt: idt,
            refresh_token: refresh_token || null,
            refresh_token_obtained: refresh_token ? Date.now() : null
        };

        user.puuid = decodeToken(rso).sub;

        // Check if this account already exists
        const existingAccount = getAccountWithPuuid(id, user.puuid);
        if (existingAccount) {
            user.username = existingAccount.username;
            user.region = existingAccount.region;
            if (existingAccount.auth) user.auth.ent = existingAccount.auth.ent;
        }

        // Get username from userinfo
        const userInfo = await getUserInfo(user);
        if (!userInfo || !userInfo.username) {
            return { success: false, error: "Could not fetch user info. The token may be invalid or expired." };
        }
        user.username = userInfo.username;

        // Get entitlements token
        if (!user.auth.ent) {
            user.auth.ent = await getEntitlements(user);
        }

        // Get region
        if (!user.region) {
            user.region = await getRegion(user);
        }

        if (refresh_token) {
            console.log(`[redeemWebAuthUrl] Code flow login successful for ${user.username} (has refresh token - auto-refresh enabled)`);
        } else {
            console.log(`[redeemWebAuthUrl] Code flow login successful for ${user.username} (no refresh token returned)`);
        }

        user.lastFetchedData = Date.now();
        user.authFailures = 0;

        addUser(user);

        return { success: true, username: user.username };
    } catch (e) {
        console.error("Error redeeming web auth URL:", e);
        return { success: false, error: e.message || "Unknown error occurred" };
    }
}
