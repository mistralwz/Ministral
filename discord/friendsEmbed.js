import { EmbedBuilder } from "discord.js";
import { s } from "../misc/languages.js";
import { resolveQueueName } from "../valorant/livegame.js";

const STATE_ICONS = {
    INGAME: "🎮",
    PREGAME: "⏳",
    ONLINE: "🟢",
    OFFLINE: "⚫"
};

const stateLabel = (strings, friend) => {
    if (friend.state === "INGAME") {
        return friend.queueId
            ? strings.FRIEND_PLAYING.f({ q: resolveQueueName(friend.queueId, "en-US") })
            : strings.FRIEND_IN_GAME;
    }
    if (friend.state === "PREGAME") return strings.FRIEND_AGENT_SELECT;
    if (friend.state === "ONLINE") return strings.FRIEND_ONLINE;
    return strings.FRIEND_OFFLINE;
};

export const renderFriends = (interaction, friendsRes) => {
    const strings = s(interaction).info;
    const friends = friendsRes.friends || [];
    const online = friends.filter(f => f.state !== "OFFLINE");
    const offline = friends.filter(f => f.state === "OFFLINE");

    const embed = new EmbedBuilder()
        .setColor(0xfa4454)
        .setTitle(strings.FRIENDS_HEADER)
        .setDescription(strings.FRIENDS_COUNT.f({ o: online.length, f: offline.length }));

    const format = (friend) => {
        const line = `${STATE_ICONS[friend.state] || "❓"} **${friend.name}#${friend.tag}**`;
        return `${line} — ${stateLabel(strings, friend)}`;
    };

    if (online.length > 0) {
        embed.addFields({
            name: strings.FRIENDS_ONLINE.f({ n: online.length }),
            value: online.slice(0, 25).map(format).join("\n").slice(0, 1024)
        });
    }

    if (offline.length > 0) {
        embed.addFields({
            name: strings.FRIENDS_OFFLINE.f({ n: offline.length }),
            value: offline.slice(0, 25).map(f => `⚫ **${f.name}#${f.tag}**`).join("\n").slice(0, 1024)
        });
    }

    if (friends.length === 0) {
        embed.setDescription(strings.FRIENDS_EMPTY);
    }

    return { embeds: [embed] };
};
