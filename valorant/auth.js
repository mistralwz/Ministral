import {
    fetch,
    tokenExpiry,
    decodeToken,
    wait,
    getRiotVersionData,
    fetchRiotVersionData
} from "../misc/util.js";
import config from "../misc/config.js";
import { addUser, getAccountWithPuuid, getUserJson, readUserJson, saveUser } from "./accountSwitcher.js";
import { getAllUserIds, getUserIdsWithAlertsOrDailyShop } from "../misc/userDatabase.js";

export class User {
    constructor({ id, puuid, auth, alerts = [], username, region, authFailures, lastFetchedData, lastNoticeSeen, lastSawEasterEgg }) {
        this.id = id;
        this.puuid = puuid;
        this.auth = auth;
        this.alerts = alerts || [];
        this.username = username;
        this.region = region;
        this.authFailures = authFailures || 0;
        this.lastFetchedData = lastFetchedData || 0;
        this.lastNoticeSeen = lastNoticeSeen || "";
        this.lastSawEasterEgg = lastSawEasterEgg || 0;
    }
}

export const getUser = (id, account = null) => {
    if (!id) return null;

    if (id instanceof User) {
        const user = id;
        const userJson = readUserJson(user.id);
        if (!userJson) return null;

        const userData = userJson.accounts.find(a => a.puuid === user.puuid);
        return userData && new User(userData);
    }

    try {
        const userData = getUserJson(id, account);
        return userData && new User(userData);
    } catch (e) {
        return null;
    }
};

export const getPuuid = (id, account = null) => {
    const user = getUser(id, account);
    return user ? user.puuid : null;
};

export const getUserList = () => {
    const userIds = getAllUserIds();
    if (config.logUrls) console.log(`[getUserList] Retrieved ${userIds.length} users from database`);
    return userIds;
};

export const getAlertUserList = () => {
    const userIds = getUserIdsWithAlertsOrDailyShop();
    if (config.logUrls) console.log(`[getAlertUserList] Retrieved ${userIds.length} active alert users from database`);
    return userIds;
};

export const authUser = async (id, account = null) => {
    const user = getUser(id, account);
    if (!user || !user.auth || !user.auth.rso) return { success: false };

    // If entitlements token is missing, re-fetch it or refresh tokens
    if (!user.auth.ent) {
        try {
            user.auth.ent = await fetchEntitlementsToken(user);
            if (user.auth.ent) {
                saveUser(user);
            }
        } catch {}
        if (!user.auth.ent) {
            return await refreshToken(id, account);
        }
    }

    const rsoExpiry = tokenExpiry(user.auth.rso);
    const timeRemaining = rsoExpiry - Date.now();
    const minutesRemaining = Math.floor(timeRemaining / 60000);

    if (!config.autoRefreshTokens) {
        if (timeRemaining > 0) {
            if (config.logUrls) console.log(`[authUser] Token valid for ${minutesRemaining} more minutes (${user.username})`);
            return { success: true };
        }
        return { success: false };
    }

    const bufferMs = (config.tokenRefreshBufferMinutes || 5) * 60 * 1000;
    if (timeRemaining > bufferMs) {
        if (config.logUrls) console.log(`[authUser] Token valid for ${minutesRemaining} more minutes (${user.username})`);
        return { success: true };
    }

    if (config.logUrls) console.log(`[authUser] Token expires in ${minutesRemaining} minutes, refreshing now (${user.username})`);
    return await refreshToken(id, account);
};

export const getUserInfo = async (user) => {
    const req = await fetch("https://auth.riotgames.com/userinfo", {
        headers: {
            'Authorization': "Bearer " + user.auth.rso
        }
    });

    if (req.statusCode !== 200) {
        console.error(`User info status code is ${req.statusCode}`);
        return null;
    }

    const json = JSON.parse(req.body);
    if (json.acct) return {
        puuid: json.sub,
        username: json.acct.game_name && json.acct.game_name + "#" + json.acct.tag_line
    };
    return null;
};

export const fetchEntitlementsToken = async (user) => {
    const req = await fetch("https://entitlements.auth.riotgames.com/api/token/v1", {
        method: "POST",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': "Bearer " + user.auth.rso
        }
    });

    if (req.statusCode !== 200) {
        console.error(`Entitlements token status code is ${req.statusCode}`);
        return null;
    }

    const json = JSON.parse(req.body);
    return json.entitlements_token;
};

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

    if (req.statusCode !== 200) {
        console.error(`PAS token status code is ${req.statusCode}`);
        return null;
    }

    const json = JSON.parse(req.body);
    return json.affinities.live;
};

const activeRefreshes = new Map();

export const refreshToken = async (id, account = null) => {
    let user = getUser(id, account);
    if (!user) return { success: false };

    // If another shard/process already refreshed this token in SQLite, reuse it immediately.
    // ent must be present too: authUser falls through to here precisely when ent is missing.
    if (user.auth?.rso && user.auth?.ent) {
        const rsoExpiry = tokenExpiry(user.auth.rso);
        const bufferMs = (config.tokenRefreshBufferMinutes || 5) * 60 * 1000;
        if (rsoExpiry - Date.now() > bufferMs) {
            return { success: true };
        }
    }

    if (config.logUrls) console.log(`Refreshing token for ${id}...`);

    const lockKey = `${user.id}:${user.puuid || account || ''}`;
    if (activeRefreshes.has(lockKey)) {
        return await activeRefreshes.get(lockKey);
    }

    const refreshPromise = (async () => {
        try {
            if (user.auth && user.auth.refresh_token) {
                if (config.logUrls) console.log(`[refreshToken] User has refresh_token, attempting refresh`);
                try {
                    const refreshRes = await refreshWithRefreshToken(user.auth.refresh_token);
                    if (refreshRes.success && refreshRes.tokenData && refreshRes.tokenData.access_token) {
                        const tokenData = refreshRes.tokenData;
                        user.auth.rso = tokenData.access_token;
                        if (tokenData.id_token) user.auth.idt = tokenData.id_token;
                        if (tokenData.refresh_token) {
                            user.auth.refresh_token = tokenData.refresh_token;
                            user.auth.refresh_token_obtained = Date.now();
                        }
                        try {
                            user.auth.ent = await fetchEntitlementsToken(user);
                        } catch (e) {
                            console.error(`[refreshToken] Failed to re-fetch entitlements:`, e);
                        }
                        user.lastFetchedData = Date.now();
                        user.authFailures = 0;
                        saveUser(user);

                        const newExpiry = tokenExpiry(user.auth.rso);
                        const expiresIn = Math.floor((newExpiry - Date.now()) / 60000);
                        if (config.logUrls) console.log(`[refreshToken] Refresh token success for ${user.username} — new token expires in ${expiresIn} minutes`);
                        return { success: true };
                    } else if (refreshRes.invalidToken) {
                        // Check if another process/shard updated the DB with a newer refresh token before wiping auth
                        const freshUser = getUserJson(user.id, account);
                        if (freshUser?.auth?.refresh_token && freshUser.auth.refresh_token !== user.auth.refresh_token) {
                            return { success: true };
                        }

                        console.error(`[refreshToken] Refresh token is invalid/expired for ${user.username} (HTTP invalid_grant/400/401)`);
                        deleteUserAuth(user);
                        return { success: false, authFailure: true };
                    } else if (refreshRes.rateLimit || refreshRes.statusCode === 429) {
                        const retryAfter = refreshRes.retryAfter || 30000;
                        console.warn(`[refreshToken] Rate limited while refreshing token for ${user.username} (retry after ${Math.ceil(retryAfter / 1000)}s)`);
                        return { success: false, rateLimit: Date.now() + retryAfter };
                    } else {
                        console.error(`[refreshToken] Transient error refreshing token for ${user.username} (status ${refreshRes.statusCode || 'network'}), keeping credentials`);
                        return { success: false, networkError: true };
                    }
                } catch (e) {
                    console.error(`[refreshToken] Exception during refresh_token flow:`, e);
                    return { success: false, networkError: true };
                }
            }

            // Only delete auth if user does not have a refresh_token
            deleteUserAuth(user);
            return { success: false, authFailure: true };
        } finally {
            activeRefreshes.delete(lockKey);
        }
    })();

    activeRefreshes.set(lockKey, refreshPromise);
    return await refreshPromise;
};

export const deleteUserAuth = (user) => {
    user.auth = {};
    saveUser(user);
};

let cachedUserAgent = null;

export const getUserAgent = async () => {
    if (cachedUserAgent) return cachedUserAgent;
    let versionData = getRiotVersionData();
    if (!versionData) {
        versionData = await fetchRiotVersionData();
    }
    const version = versionData ? (versionData.riotClientBuild || versionData.riotClientVersion) : "release-10.00-shipping-0-0000000";
    cachedUserAgent = `RiotClient/${version} rso-auth (Windows;10;;Professional, x64)`;
    return cachedUserAgent;
};

export const generateWebAuthUrl = () => {
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
};

const extractCodeFromUri = (uri) => {
    try {
        const url = new URL(uri);
        return url.searchParams.get("code");
    } catch {
        const match = uri.match(/[?&]code=([^&]+)/);
        return match ? match[1] : null;
    }
};

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
    return json;
};

export const refreshWithRefreshToken = async (refreshToken) => {
    try {
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
            if (req.statusCode === 429) {
                const retryAfterHeader = req.headers?.['retry-after'];
                const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 30000;
                return { success: false, rateLimit: true, statusCode: 429, retryAfter };
            }

            let invalidToken = false;
            try {
                const json = JSON.parse(req.body);
                if (json.error === "invalid_grant" || json.error === "bad_claims") {
                    invalidToken = true;
                }
            } catch {
                invalidToken = false;
            }
            return { success: false, invalidToken, statusCode: req.statusCode };
        }

        const json = JSON.parse(req.body);
        return { success: true, tokenData: json };
    } catch (e) {
        console.error(`[refreshWithRefreshToken] Exception during token refresh:`, e);
        return { success: false, networkError: true };
    }
};

export const redeemWebAuthUrl = async (id, callbackUrl) => {
    try {
        const code = extractCodeFromUri(callbackUrl);
        if (!code) {
            return { success: false, error: "Could not extract authorization code from URL. Make sure you copied the full URL from the browser address bar." };
        }

        const tokenData = await exchangeCodeForTokens(code);
        if (!tokenData || !tokenData.access_token) {
            return { success: false, error: "Failed to exchange authorization code for tokens. The code may have expired (they are single-use)." };
        }

        const rso = tokenData.access_token;
        const idt = tokenData.id_token;
        const refresh_token = tokenData.refresh_token;

        const user = new User({ id });
        user.auth = {
            rso: rso,
            idt: idt,
            refresh_token: refresh_token || null,
            refresh_token_obtained: refresh_token ? Date.now() : null
        };

        user.puuid = decodeToken(rso).sub;

        const existingAccount = getAccountWithPuuid(id, user.puuid);
        if (existingAccount) {
            user.username = existingAccount.username;
            user.region = existingAccount.region;
            if (existingAccount.auth) user.auth.ent = existingAccount.auth.ent;
        }

        const [userInfo, entitlements, region] = await Promise.all([
            getUserInfo(user),
            user.auth.ent ? Promise.resolve(user.auth.ent) : fetchEntitlementsToken(user),
            user.region ? Promise.resolve(user.region) : getRegion(user)
        ]);

        if (!userInfo || !userInfo.username) {
            return { success: false, error: "Could not fetch user info. The token may be invalid or expired." };
        }

        user.username = userInfo.username;
        user.auth.ent = entitlements;
        user.region = region;

        user.lastFetchedData = Date.now();
        user.authFailures = 0;

        addUser(user);

        return { success: true, username: user.username };
    } catch (e) {
        console.error("Error redeeming web auth URL:", e);
        return { success: false, error: e.message || "Unknown error occurred" };
    }
};
