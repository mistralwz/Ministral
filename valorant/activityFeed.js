import { getUserList, getUser } from "./auth.js";
import { getFriendsOverview } from "./party.js";
import { getSetting } from "../misc/settings.js";

const lastStates = new Map();
let feedTimer = null;

const describeState = (presence) => {
    if (!presence || presence.state === "OFFLINE") return "offline";
    if (presence.state === "INGAME" && presence.queueId) {
        return `playing ${presence.queueId.charAt(0).toUpperCase() + presence.queueId.slice(1)}`;
    }
    if (presence.state === "PREGAME") return "in agent select";
    return "in menu";
};

export const pollFriendActivity = async () => {
    const users = getUserList();
    for (const discordId of users) {
        try {
            if (!getSetting(discordId, "friendActivityFeed")) {
                lastStates.delete(discordId);
                continue;
            }

            const res = await getFriendsOverview(discordId);
            if (!res.success) continue;

            const current = {};
            for (const f of res.friends) {
                if (!f.presence) continue;
                const desc = describeState(f.presence);
                if (desc !== "offline" && desc !== "in menu") {
                    current[f.puuid] = { name: `${f.name}#${f.tag}`, desc };
                }
            }

            const prev = lastStates.get(discordId) || {};
            const changes = [];
            for (const [puuid, info] of Object.entries(current)) {
                if (prev[puuid]?.desc !== info.desc) {
                    changes.push(`**${info.name}** — ${info.desc}`);
                }
            }
            for (const [puuid, info] of Object.entries(prev)) {
                if (!current[puuid]) {
                    changes.push(`**${info.name}** — offline`);
                }
            }

            if (changes.length > 0 && Object.keys(prev).length > 0) {
                const { sendActivityFeed } = await import("./activityFeedSink.js");
                await sendActivityFeed(discordId, changes.slice(0, 10));
            }

            lastStates.set(discordId, current);
        } catch (e) {
            console.error(`[activityfeed] error for ${discordId}:`, e.message);
        }
    }
};

export const startActivityFeed = (intervalMs = 120000) => {
    stopActivityFeed();
    feedTimer = setInterval(() => pollFriendActivity().catch(e => console.error("[activityfeed]", e.message)), intervalMs);
};

export const stopActivityFeed = () => {
    if (feedTimer) clearInterval(feedTimer);
    feedTimer = null;
};
