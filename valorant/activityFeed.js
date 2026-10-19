import { getUserList } from "./auth.js";
import { getFriendsOverview } from "./party.js";
import { resolveQueueName } from "./livegame.js";
import { s } from "../misc/languages.js";
import { getSetting } from "../misc/settings.js";

const lastStates = new Map();
let feedTimer = null;

const describeState = (strings, friend) => {
    if (friend.state === "INGAME") {
        return friend.queueId
            ? strings.FRIEND_PLAYING.f({ q: resolveQueueName(friend.queueId, "en-US") })
            : strings.FRIEND_IN_GAME;
    }
    if (friend.state === "PREGAME") return strings.FRIEND_AGENT_SELECT;
    return strings.FRIEND_ONLINE;
};

export const pollFriendActivity = async () => {
    for (const discordId of getUserList()) {
        try {
            if (!getSetting(discordId, "friendActivityFeed")) {
                lastStates.delete(discordId);
                continue;
            }

            const res = await getFriendsOverview(discordId);
            if (!res.success) continue;

            const strings = s(discordId).info;
            const current = {};
            for (const friend of res.friends) {
                // Menus and offline friends aren't worth a notification, so the
                // feed only ever tracks people who moved into a game.
                if (friend.state !== "INGAME" && friend.state !== "PREGAME") continue;
                current[friend.puuid] = {
                    name: `${friend.name}#${friend.tag}`,
                    description: describeState(strings, friend)
                };
            }

            const previous = lastStates.get(discordId) || {};
            const changes = [];

            for (const [puuid, info] of Object.entries(current)) {
                if (previous[puuid]?.description !== info.description) {
                    changes.push(`**${info.name}** — ${info.description}`);
                }
            }
            for (const [puuid, info] of Object.entries(previous)) {
                if (!current[puuid]) changes.push(`**${info.name}** — ${strings.FRIEND_STOPPED_PLAYING}`);
            }

            // Skipped on the first poll after startup (or after the setting was
            // switched on) so nobody gets a wall of "came online" messages.
            if (changes.length > 0 && Object.keys(previous).length > 0) {
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
