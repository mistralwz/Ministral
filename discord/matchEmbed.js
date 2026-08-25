import { EmbedBuilder } from "discord.js";
import { getAccountInfo, fetchMatchHistory } from "../valorant/profile.js";

export const renderMatchResult = async (interaction, user, tracked = false) => {
    const account = await getAccountInfo(user, interaction);
    if (!account.success) return tracked ? null : { embeds: [new EmbedBuilder().setColor(0xff4655).setDescription(account.error || "Could not fetch your account.")] };

    const history = await fetchMatchHistory(interaction, user);
    if (!history.success) return tracked ? null : { embeds: [new EmbedBuilder().setColor(0xff4655).setDescription(history.error || "No match data available.")] };

    const m = history.data[0];
    if (!m) return tracked ? null : { embeds: [new EmbedBuilder().setColor(0xff4655).setDescription("No recent matches found.")] };

    if (tracked && m.metadata.game_start && Date.now() / 1000 - m.metadata.game_start < m.metadata.game_length + 600) {
        return null;
    }

    const won = m.player.has_won;
    const draw = m.player.is_draw;
    const color = draw ? 0xf5b942 : won ? 0x2ecc71 : 0xe74c3c;
    const result = draw ? "DRAW" : won ? "VICTORY" : "DEFEAT";

    const date = m.metadata.game_start ? `<t:${m.metadata.game_start}:R>` : "";
    const score = `${m.metadata.pt_round_won ?? "?"} - ${m.metadata.et_round_won ?? "?"}`;

    let desc = `**${m.metadata.map}** · ${date}\n\`${score}\` · ${m.player.kills}/${m.player.deaths}/${m.player.assists} KDA`;
    if (m.player.mmr !== undefined && m.player.currenttier_patched) {
        desc += `\n**${m.player.currenttier_patched}** ${m.player.mmr ? `(${m.player.mmr} RR)` : ""}`;
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`Last match — ${result}`)
        .setDescription(desc)
        .addFields(
            { name: "ACS", value: String(m.player.average_combat_score), inline: true },
            { name: "HS%", value: `${m.player.hs_percent}%`, inline: true },
            { name: "ADR", value: String(m.player.average_damage_round), inline: true },
            { name: "Placement", value: m.player.position, inline: true },
            { name: "KD", value: String(m.player.kd), inline: true }
        );

    if (m.player.agent?.iconUrl) embed.setThumbnail(m.player.agent.iconUrl);

    return { embeds: [embed] };
};
