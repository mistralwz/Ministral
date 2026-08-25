import { fetch, safeJson, userRegion, riotClientHeaders } from "../misc/util.js";
import { authUser, getUser } from "./auth.js";

const glzUrl = (user) => `https://glz-${user.region}-1.${userRegion(user)}.a.pvp.net`;

const authHeaders = (user) => ({
    "Authorization": `Bearer ${user.auth.rso}`,
    "X-Riot-Entitlements-JWT": user.auth.ent,
    ...riotClientHeaders(),
});

const parsePresence = (privateJson) => {
    let parsed = {};
    try {
        parsed = JSON.parse(Buffer.from(privateJson, "base64").toString("utf8"));
    } catch (e) {
        return {};
    }
    return {
        state: parsed.state || null,
        level: parsed.isValid ? parseInt(parsed.level) || 0 : 0,
        partySize: parsed.partySize || 1,
        queueId: parsed.matchQueueId || null,
        programId: parsed.program === null ? null : String(parsed.program),
    };
};

export const getFriends = async (id, account = null) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return authResult;

    const user = getUser(id, account);
    if (!user) return { success: false };

    const resp = await fetch(`${glzUrl(user)}/friends/v2/friends`, { headers: authHeaders(user) });
    if (resp.statusCode !== 200) return { success: false, networkError: true };

    const json = safeJson(resp.body);
    if (!json || !json.friends) return { success: true, friends: [] };

    const friends = json.friends.map(f => ({
        puuid: f.puuid,
        name: f.game_name || f.gameName,
        tag: f.tag_line || f.tagLine,
        note: f.note || ""
    }));

    return { success: true, friends };
};

export const getPresences = async (id, account = null) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return authResult;

    const user = getUser(id, account);
    if (!user) return { success: false };

    const resp = await fetch(`${glzUrl(user)}/presence/v1/players/${user.puuid}`, { headers: authHeaders(user) });
    if (resp.statusCode !== 200) return { success: true, presences: {} };

    const json = safeJson(resp.body);
    const presences = {};
    for (const p of json || []) {
        presences[p.puuid] = parsePresence(p.private);
    }
    return { success: true, presences };
};

export const getFriendsOverview = async (id, account = null) => {
    const friendsRes = await getFriends(id, account);
    if (!friendsRes.success) return friendsRes;

    const presencesRes = await getPresences(id, account);
    const presences = presencesRes.success ? presencesRes.presences : {};

    const friends = friendsRes.friends.map(f => ({
        ...f,
        presence: presences[f.puuid] || null
    })).sort((a, b) => {
        const aOnline = a.presence && a.presence.state !== "OFFLINE";
        const bOnline = b.presence && b.presence.state !== "OFFLINE";
        if (aOnline !== bOnline) return aOnline ? -1 : 1;
        return (a.name || "").localeCompare(b.name || "");
    });

    return { success: true, friends };
};
