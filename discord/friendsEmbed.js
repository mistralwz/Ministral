import { EmbedBuilder } from "discord.js";

const STATE_ICONS = {
    "INGAME": "🎮",
    "PREGAME": "⏳",
    "MENU": "🏠",
    "OFFLINE": "⚫"
};

export const renderFriends = (interaction, friendsRes) => {
    const friends = friendsRes.friends || [];
    const online = friends.filter(f => f.presence && f.presence.state !== "OFFLINE");
    const offline = friends.filter(f => !f.presence || f.presence.state === "OFFLINE");

    const embed = new EmbedBuilder()
        .setColor(0xfa4454)
        .setTitle("Valorant Friends")
        .setDescription(`${online.length} online · ${offline.length} offline`);

    const fmt = (f) => {
        const p = f.presence;
        const icon = STATE_ICONS[p?.state] || "❓";
        let line = `${icon} **${f.name}#${f.tag}**`;
        if (p && p.state === "INGAME" && p.queueId) {
            const q = p.queueId.charAt(0).toUpperCase() + p.queueId.slice(1);
            line += ` — playing ${q}`;
        } else if (p && p.state === "PREGAME") {
            line += " — agent select";
        }
        return line;
    };

    if (online.length > 0) {
        embed.addFields({
            name: `Online (${online.length})`,
            value: online.slice(0, 25).map(fmt).join("\n").slice(0, 1024)
        });
    }

    if (offline.length > 0) {
        embed.addFields({
            name: `Offline (${offline.length})`,
            value: offline.slice(0, 25).map(f => `⚫ **${f.name}#${f.tag}**`).join("\n").slice(0, 1024)
        });
    }

    if (friends.length === 0) {
        embed.setDescription("Your friends list is empty.");
    }

    return { embeds: [embed] };
};
