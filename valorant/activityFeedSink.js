import { fetchChannel } from "../discord/embed.js";
import { EmbedBuilder } from "discord.js";

let client = null;

export const setActivityFeedClient = (c) => {
    client = c;
};

export const sendActivityFeed = async (userId, changes) => {
    if (!client || !changes?.length) return;
    try {
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return;

        const embed = new EmbedBuilder()
            .setColor(0xfa4454)
            .setTitle("Friend activity")
            .setDescription(changes.join("\n"))
            .setTimestamp();

        await user.send({ embeds: [embed] });
    } catch {
        // DMs closed or user unreachable — skip silently
    }
};
