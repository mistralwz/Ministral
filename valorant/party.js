import { localRequest } from "../misc/localClient.js";
import { authUser, getUser } from "./auth.js";

// Friends and presences live on the local client only. The friend list itself
// comes from /chat/v4/friends, and /chat/v4/presences holds one entry per
// online friend - for Valorant ones, `private` is a base64 JSON blob with the
// live session state (menu / agent select / in game).

export const parseValorantPresence = (value) => {
    if (!value) return {};
    try {
        const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
        return {
            state: parsed.sessionLoopState || null,
            queueId: parsed.queueId ? String(parsed.queueId).toLowerCase() : null,
            partySize: parsed.partySize || 1,
            partyId: parsed.partyId || null,
            level: parsed.accountLevel || 0,
            tier: parsed.competitiveTier || 0
        };
    } catch {
        return {};
    }
};

export const getFriends = async (id, account = null) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return authResult;

    const user = getUser(id, account);
    if (!user) return { success: false };

    const res = await localRequest("/chat/v4/friends");
    if (!res.success) return res;
    if (!Array.isArray(res.data?.friends)) return { success: false, networkError: true };

    const friends = res.data.friends.map(friend => ({
        puuid: friend.puuid,
        name: friend.game_name || friend.name || "",
        tag: friend.game_tag || "",
        note: friend.note || "",
        online: Boolean(friend.activePlatform),
        lastOnline: friend.last_online_ts || null
    }));

    return { success: true, friends };
};

export const getPresences = async () => {
    const res = await localRequest("/chat/v4/presences");
    if (!res.success) return res;

    const presences = {};
    for (const presence of res.data?.presences || []) {
        if (presence.product && presence.product !== "valorant") continue;
        presences[String(presence.puuid).toLowerCase()] = parseValorantPresence(presence.private);
    }

    return { success: true, presences };
};

const stateFor = (friend, presence) => {
    // INGAME / PREGAME come from the Valorant session blob; anything else that
    // is reachable is just "online" (in the client menu, or on another game).
    if (presence?.state === "INGAME" || presence?.state === "PREGAME") return presence.state;
    if (presence?.state === "MENU" || friend.online) return "ONLINE";
    return "OFFLINE";
};

const STATE_ORDER = { INGAME: 0, PREGAME: 1, ONLINE: 2, OFFLINE: 3 };

export const getFriendsOverview = async (id, account = null) => {
    const friendsRes = await getFriends(id, account);
    if (!friendsRes.success) return friendsRes;

    const presencesRes = await getPresences();
    const presences = presencesRes.success ? presencesRes.presences : {};

    const friends = friendsRes.friends.map(friend => {
        const presence = presences[String(friend.puuid).toLowerCase()] || null;
        return {
            ...friend,
            state: stateFor(friend, presence),
            queueId: presence?.queueId || null,
            partySize: presence?.partySize || 1,
            level: presence?.level || 0,
            tier: presence?.tier || 0
        };
    });

    friends.sort((a, b) => {
        const order = (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3);
        if (order !== 0) return order;
        return (a.name || "").localeCompare(b.name || "");
    });

    return { success: true, friends };
};
