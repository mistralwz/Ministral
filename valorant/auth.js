import { threadId } from "node:worker_threads";
import {
    fetch,
    safeJson,
    tokenExpiry,
    decodeToken,
    wait,
    getRiotVersionData,
    fetchRiotVersionData
} from "../misc/util.js";
import config from "../misc/config.js";
import { addUser, getAccountWithPuuid, getUserJson, readUserJson, saveUser } from "./accountSwitcher.js";
import { getAllUserIds, getUserIdsWithAlertsOrDailyShop, acquireRefreshLock, releaseRefreshLock } from "../misc/userDatabase.js";

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

    const json = safeJson(req.body);
    if (json?.acct) return {
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

    return safeJson(req.body)?.entitlements_token ?? null;
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

    return safeJson(req.body)?.affinities?.live ?? null;
};

const activeRefreshes = new Map();

/** Test hook: in-flight refresh count. Must be 0 whenever none is running. */
export const activeRefreshCount = () => activeRefreshes.size;

// activeRefreshes only dedupes refreshes within this process. Riot rotates
// refresh tokens on every use, so a second shard refreshing the same account
// at the same time doesn't just waste a request — it gets a real invalid_grant
// back and looks like the user got logged out. This lock (backed by SQLite,
// the one store every shard already shares) keeps refreshes for one account
// serialized across shards too.
const REFRESH_LOCK_TTL_MS = 15000;
const REFRESH_LOCK_MAX_WAIT_MS = 17000;
const REFRESH_LOCK_POLL_MS = 400;
// ShardingManager runs shards as worker_threads, which share one OS process —
// process.pid alone is identical across every shard on the same machine.
// threadId is what's actually unique per shard; pid still separates machines
// if this ever runs across more than one host.
const lockOwnerId = `${process.pid}-${threadId}`;

const claimCrossShardRefresh = async (lockKey, id, account) => {
    const deadline = Date.now() + REFRESH_LOCK_MAX_WAIT_MS;
    while (true) {
        if (acquireRefreshLock(lockKey, lockOwnerId, REFRESH_LOCK_TTL_MS)) return { gotLock: true };

        // Someone else holds it — check if they already finished before waiting on them.
        const freshUser = getUserJson(id, account);
        if (freshUser?.auth?.rso && tokenExpiry(freshUser.auth.rso) > Date.now()) {
            return { gotLock: false, alreadyFresh: true };
        }

        if (Date.now() >= deadline) return { gotLock: false, alreadyFresh: false };
        await wait(REFRESH_LOCK_POLL_MS);
    }
};

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
        const { gotLock, alreadyFresh } = await claimCrossShardRefresh(lockKey, user.id, account);
        if (alreadyFresh) return { success: true };
        if (!gotLock) console.warn(`[refreshToken] Timed out waiting on cross-shard lock for ${user.username}, proceeding without it`);

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
        } catch (e) {
            console.error(`[refreshToken] Unexpected error for ${user.username}:`, e);
            return { success: false, networkError: true };
        } finally {
            if (gotLock) releaseRefreshLock(lockKey, lockOwnerId);
        }
    })();

    // The lock is released here, after the promise is registered — not in a
    // `finally` inside the IIFE. The no-refresh_token path above has no
    // `await` in it, so it ran to completion (and released the lock) *before*
    // the line that registered it, leaving a settled failure cached under this
    // key forever: the user could log in again and every later refresh would
    // still be served that stale {authFailure: true} until the bot restarted.
    activeRefreshes.set(lockKey, refreshPromise);
    try {
        return await refreshPromise;
    } finally {
        activeRefreshes.delete(lockKey);
    }
};

export const deleteUserAuth = (user) => {
    user.auth = {};
    saveUser(user);
};

// BAD_CLAIMS fires after authUser() already confirmed rso isn't expired, so
// it almost always means only the entitlements token went stale on its own
// clock. Re-fetch just that with the still-good rso instead of wiping the
// whole login (rso/idt/refresh_token) and forcing a full re-auth.
export const handleBadClaims = async (user) => {
    try {
        const ent = await fetchEntitlementsToken(user);
        if (ent) {
            user.auth.ent = ent;
            saveUser(user);
            return { success: false, retry: true };
        }
    } catch {}
    deleteUserAuth(user);
    return { success: false, authFailure: true };
};

export const getUserAgent = async () => {
    // Riot's client build rotates on every patch and is kept fresh in
    // util.js by a 15min cron + cross-shard broadcast (see bot.js
    // scheduleTasks). Read that cache each call instead of memoizing our
    // own copy here — a private cache would freeze at boot and never pick
    // up later patches, silently sending a stale build to Riot's auth
    // servers for the rest of the process's uptime.
    let versionData = getRiotVersionData();
    if (!versionData) {
        versionData = await fetchRiotVersionData();
    }
    const version = versionData ? (versionData.riotClientBuild || versionData.riotClientVersion) : "release-10.00-shipping-0-0000000";
    return `RiotClient/${version} rso-auth (Windows;10;;Professional, x64)`;
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

    return safeJson(req.body);
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

            const errJson = safeJson(req.body);
            const invalidToken = errJson?.error === "invalid_grant" || errJson?.error === "bad_claims";
            return { success: false, invalidToken, statusCode: req.statusCode };
        }

        const json = safeJson(req.body);
        // A 200 that isn't JSON is not a successful refresh — treat it as
        // transient so the caller keeps the user's credentials.
        if (!json) return { success: false, networkError: true };
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
