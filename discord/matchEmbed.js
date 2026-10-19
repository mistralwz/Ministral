import { EmbedBuilder } from "discord.js";
import { s } from "../misc/languages.js";
import { getAccountInfo, fetchMatchHistory } from "../valorant/profile.js";

export const renderMatchResult = async (interaction, user, tracked = false) => {
    const strings = s(interaction);
    const fail = (key) => tracked ? null : { embeds: [new EmbedBuilder().setColor(0xff4655).setDescription(key)] };

    const account = await getAccountInfo(user, interaction);
    if (!account.success) return fail(account.error || strings.error.MATCH_RESULT_FAILED);

    const history = await fetchMatchHistory(interaction, user);
    if (!history.success) return fail(history.error || strings.error.MATCH_RESULT_FAILED);

    const match = history.data[0];
    if (!match) return fail(strings.error.NO_MATCH_DATA.f({ m: "competitive" }));

    // A tracked game is only reported once Riot has actually finished writing
    // it, otherwise we'd repost the previous match and call it a result.
    if (tracked && match.metadata.game_start &&
        Date.now() / 1000 - match.metadata.game_start < match.metadata.game_length + 600) {
        return null;
    }

    const won = match.player.has_won;
    const draw = match.player.is_draw;
    const color = draw ? 0xf5b942 : won ? 0x2ecc71 : 0xe74c3c;
    const result = draw ? strings.match.DRAW : won ? strings.match.VICTORY : strings.match.DEFEAT;

    const date = match.metadata.game_start ? `<t:${match.metadata.game_start}:R>` : "";
    const score = `${match.metadata.pt_round_won ?? "?"} - ${match.metadata.et_round_won ?? "?"}`;

    let description = `**${match.metadata.map}** · ${date}\n\`${score}\` · ${match.player.kills}/${match.player.deaths}/${match.player.assists} KDA`;
    if (match.player.mmr !== undefined && match.player.currenttier_patched) {
        description += `\n**${match.player.currenttier_patched}** ${match.player.mmr ? `(${match.player.mmr} ${strings.match.RANKED_RATING})` : ""}`;
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(strings.match.LAST_MATCH_TITLE.f({ r: result }))
        .setDescription(description)
        .addFields(
            { name: strings.match.AVERAGE_COMBAT_SCORE, value: String(match.player.average_combat_score), inline: true },
            { name: strings.match.HS_PERCENT, value: `${match.player.hs_percent}%`, inline: true },
            { name: strings.match.AVERAGE_DAMAGE_ROUND, value: String(match.player.average_damage_round), inline: true },
            { name: strings.match.PLACEMENT, value: String(match.player.position), inline: true },
            { name: strings.match.AVG_KD, value: String(match.player.kd), inline: true }
        );

    if (match.player.agent?.iconUrl) embed.setThumbnail(match.player.agent.iconUrl);

    return { embeds: [embed] };
};
