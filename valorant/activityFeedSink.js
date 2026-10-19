import { EmbedBuilder } from "discord.js";
import { getClient } from "../misc/client.js";
import { s } from "../misc/languages.js";

export const sendActivityFeed = async (userId, changes) => {
    const client = getClient();
    if (!client || !changes?.length) return;
    try {
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return;

        const embed = new EmbedBuilder()
            .setColor(0xfa4454)
            .setTitle(s(userId).info.ACTIVITY_HEADER)
            .setDescription(changes.join("\n"))
            .setTimestamp();

        await user.send({ embeds: [embed] });
    } catch {
        // DMs closed or user unreachable - skip silently
    }
};
