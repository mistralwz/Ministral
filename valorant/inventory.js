import { fetch, isMaintenance, userRegion, riotClientHeaders } from "../misc/util.js";
import { authUser, deleteUserAuth, getUser } from "./auth.js";
import config from "../misc/config.js";

export const getItemEntitlements = async (user, itemTypeId, itemType = "item") => {
    const req = await fetch(`https://pd.${userRegion(user)}.a.pvp.net/store/v1/entitlements/${user.puuid}/${itemTypeId}`, {
        headers: {
            "Authorization": "Bearer " + user.auth.rso,
            "X-Riot-Entitlements-JWT": user.auth.ent,
            ...riotClientHeaders(),
        }
    });

    const json = JSON.parse(req.body);
    if (json.httpStatus === 400 && json.errorCode === "BAD_CLAIMS") {
        deleteUserAuth(user);
        return { success: false, authFailure: true };
    } else if (isMaintenance(json)) {
        return { success: false, maintenance: true };
    }

    return {
        success: true,
        entitlements: json
    };
};

const skinCache = {};

export const getSkins = async (user, account = null) => {
    if (user.puuid in skinCache) {
        const cached = skinCache[user.puuid];
        const expiresIn = cached.timestamp - Date.now() + config.loadoutCacheExpiration;
        if (expiresIn <= 0) {
            delete skinCache[user.puuid];
        } else {
            return { success: true, skins: cached.skins };
        }
    }

    const authResult = await authUser(user.id, account);
    if (!authResult.success) return authResult;

    const data = await getItemEntitlements(user, "e7c63390-eda7-46e0-bb7a-a6abdacd2433", "skins");
    if (!data.success) return data;

    const skins = data.entitlements.Entitlements.map(ent => ent.ItemID);

    const skinData = {
        skins: skins,
        timestamp: Date.now()
    };

    skinCache[user.puuid] = skinData;

    return {
        success: true,
        skins: skins
    };
};

const loadoutCache = {};

export const getLoadout = async (user, account = null) => {
    if (user.puuid in loadoutCache) {
        const cached = loadoutCache[user.puuid];
        const expiresIn = cached.timestamp - Date.now() + config.loadoutCacheExpiration;
        if (expiresIn <= 0) {
            delete loadoutCache[user.puuid];
        } else {
            return { success: true, loadout: cached.loadout, favorites: cached.favorites };
        }
    }

    const authResult = await authUser(user.id, account);
    if (!authResult.success) return authResult;

    user = getUser(user.id, account);

    const req = await fetch(`https://pd.${userRegion(user)}.a.pvp.net/personalization/v2/players/${user.puuid}/playerloadout`, {
        headers: {
            "Authorization": "Bearer " + user.auth.rso,
            "X-Riot-Entitlements-JWT": user.auth.ent,
            ...riotClientHeaders(),
        }
    });

    const json = JSON.parse(req.body);
    if (json.httpStatus === 400 && json.errorCode === "BAD_CLAIMS") {
        deleteUserAuth(user);
        return { success: false, authFailure: true };
    } else if (isMaintenance(json)) {
        return { success: false, maintenance: true };
    }

    const req2 = await fetch(`https://pd.${userRegion(user)}.a.pvp.net/favorites/v1/players/${user.puuid}/favorites`, {
        headers: {
            "Authorization": "Bearer " + user.auth.rso,
            "X-Riot-Entitlements-JWT": user.auth.ent,
            ...riotClientHeaders(),
        }
    });

    const json2 = JSON.parse(req2.body);
    if (json2.httpStatus === 400 && json2.errorCode === "BAD_CLAIMS") {
        deleteUserAuth(user);
        return { success: false, authFailure: true };
    } else if (isMaintenance(json2)) {
        return { success: false, maintenance: true };
    }

    const loadoutData = {
        loadout: json,
        favorites: json2,
        timestamp: Date.now()
    };

    loadoutCache[user.puuid] = loadoutData;

    return {
        success: true,
        loadout: json,
        favorites: json2
    };
};