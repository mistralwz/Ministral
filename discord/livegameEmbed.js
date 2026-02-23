/**
 * Live Game Embed Renderer
 *
 * Produces Discord embed message objects for pre-game and in-game states.
 * Two embeds in guilds (ally + enemy), one embed in DMs.
 *
 * ── Design notes ────────────────────────────────────────────────────────────
 * Each player gets a Discord embed FIELD:
 *   field name  →  [AgentName]  RiotName#Tag
 *   field value →  Rank · RR RR  |  Peak: PeakRank  |  Lv. X  |  WR%
 *
 * You can freely edit formatPlayerField() / formatPlayerName() below to
 * change how individual players are rendered.  The rest of this file wires
 * everything together.
 * ─────────────────────────────────────────────────────────────────────────*/

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { s } from "../misc/languages.js";
import { agentEmoji, rankEmoji } from "./emoji.js";
import { emojiToString } from "../misc/util.js";

// ─── Colours ────────────────────────────────────────────────────────────────
const COLOR_PREGAME = 0xFFB300;  // amber  — agent select
const COLOR_ALLY = 0x1E88E5;  // blue   — in-game

// ─── State labels ────────────────────────────────────────────────────────────
const STATE_LABEL = {
    pregame: "🟡 Agent Select",
    ingame: "🔴 In-Game",
    not_in_game: "⬜ Not in a match",
};

// ─── Player row renderer ─────────────────────────────────────────────────────

/**
 * Render one player as a single compact line, placed in the field VALUE.
 *
 * Format (all modes):
 *   <agent>  `RiotId`・<rank> **42 RR**・<peak> (E5A3)
 *
 * Competitive also appends:
 *   ・**46%WR** (13)┊�13:5
 *
 * Level has been removed.
 * Peak rank is always shown when the player has competitive history.
 *
 * @param {object}  player
 * @param {Channel} channel       Discord channel (for emoji resolution)
 * @param {boolean} showCompStats Show WR + last match score when true
 */
const formatPlayerRow = async (player, channel, showCompStats = false) => {
    // Agent emoji — resolved dynamically from valorant-api.com icon URL.
    // For incognito players riotId IS the agent name, so we suppress the text
    // fallback to avoid "Vyse  `Vyse`" when the emoji hasn't uploaded yet.
    const agentEmojiStr = player.agentName && player.agentIcon
        ? (emojiToString(await agentEmoji(channel, player.agentName, player.agentIcon)) ?? (player.incognito ? "" : `\`${player.agentName}\``))
        : (player.incognito ? "" : `\`${player.agentName ?? "—"}\``);

    // Current rank emoji — tier 0 (Unranked) now has an icon too
    const currentRankEmojiStr = player.currentTierIcon
        ? (emojiToString(await rankEmoji(channel, player.currentTier, player.currentTierIcon)) ?? "")
        : "";

    const rankPart = player.currentTier > 0
        ? `${currentRankEmojiStr} **${player.currentRR} RR**`.trim()
        : currentRankEmojiStr || "`Unranked`";

    // Peak rank — shown in all modes; text fallback when emoji is unavailable
    const peakRankEmojiStr = player.peakTier > 0 && player.peakTierIcon
        ? (emojiToString(await rankEmoji(channel, player.peakTier, player.peakTierIcon)) ?? `\`${player.peakTierName}\``)
        : null;
    const peakPart = peakRankEmojiStr
        ? `${peakRankEmojiStr}${player.peakActLabel ? ` (${player.peakActLabel})` : ""}`
        : null;

    // Competitive-only: win-rate and last match score
    let matchScoreStr = "";
    const compParts = [];
    if (showCompStats) {
        if (player.winRate !== null)
            compParts.push(`**${player.winRate}%**wr (${player.games})`);

        const lastMatch = player.recentMatches?.[0];
        if (lastMatch) {
            matchScoreStr = `┊${lastMatch.win ? "�" : "�"}${lastMatch.allyScore}:${lastMatch.enemyScore}`;
        }
    }

    const rowTails = [rankPart, peakPart, ...compParts].filter(Boolean).join("・");
    return `${agentEmojiStr}  \`${player.riotId}\`・${rowTails}${matchScoreStr}`;
};

/**
 * Build embed fields for a list of players, grouped 5 per field.
 * @param {string} [headerName] Optional name for the first field (defaults to zero-width space).
 */
const buildPlayerFields = async (players, channel, showCompStats, headerName = "\u200b") => {
    const rows = await Promise.all(players.map(p => formatPlayerRow(p, channel, showCompStats)));
    const fields = [];
    for (let i = 0; i < rows.length; i += 5) {
        fields.push({
            name: i === 0 ? headerName : "\u200b",
            value: rows.slice(i, i + 5).join("\n"),
            inline: false,
        });
    }
    return fields;
};

// ─── Single embed builder ─────────────────────────────────────────────────────

/**
 * Build the single embed for any game state.
 *
 * • Two-team modes  → ally player fields, then a divider, then enemy fields.
 * • Single-team modes (deathmatch, …) → all players listed in `description`.
 */
const buildGameEmbed = async (data, allyPlayers, enemyPlayers, channel, localeInput = null) => {
    const stateLabel = STATE_LABEL[data.state] ?? "Live Game";
    const isPreGame = data.state === "pregame";
    const showCompStats = data.queueId === "competitive" || data.queueId === "skirmish" || data.queueId === "skirmish 2v2";
    const color = isPreGame ? COLOR_PREGAME : COLOR_ALLY;
    const mapAndServer = data.serverName
        ? `${data.mapName}・${data.serverName}`
        : data.mapName;

    const embed = {
        author: {
            name: `Live Game・${mapAndServer}`,
            icon_url: data.queueIcon ?? undefined,
        },
        color,
        image: data.mapImage ? { url: data.mapImage } : undefined,
        footer: { text: stateLabel },
        timestamp: new Date().toISOString(),
    };

    if (data.isSingleTeam) {
        // Free-for-all: description block, one player per line
        const lines = await Promise.all(
            [...allyPlayers, ...enemyPlayers].map(p => formatPlayerRow(p, channel, showCompStats))
        );
        embed.description = lines.join("\n");
    } else {
        // Two-team layout: ally players in description, enemy players in fields
        const [allyLines, enemyFields] = await Promise.all([
            Promise.all(allyPlayers.map(p => formatPlayerRow(p, channel, showCompStats))),
            enemyPlayers.length > 0
                ? buildPlayerFields(enemyPlayers, channel, showCompStats)
                : Promise.resolve([]),
        ]);
        embed.description = allyLines.join("\n");
        if (enemyFields.length > 0) embed.fields = enemyFields;
    }

    return embed;
};

// ─── Refresh button ────────────────────────────────────────────────────────

/**
 * Returns the action row with a Refresh button.
 * customId format: `livegame/refresh/{userId}`
 */
export const liveGameRefreshRow = (userId) =>
    new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`livegame/refresh/${userId}`)
            .setLabel(s(userId).livegame.REFRESH_BUTTON)
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Secondary)
    );

// ─── Main renderer ────────────────────────────────────────────────────────────

/**
 * Render the live game result to a Discord message payload.
 *
 * @param {object}  liveGameData  Return value of fetchLiveGame()
 * @param {string}  userId        Discord user ID (for the Refresh button)
 * @param {boolean} isDM          True when sending to a DM channel
 * @param {Channel} channel       Discord channel (for emoji resolution)
 * @returns Discord message payload { embeds, components }
 */
export const renderLiveGame = async (liveGameData, userId, _isDM = false, channel = null) => {
    const { state, allyPlayers = [], enemyPlayers = [] } = liveGameData;

    if (state === "not_in_game") {
        return {
            embeds: [{
                title: s(userId).livegame.NOT_IN_MATCH_TITLE,
                description: s(userId).livegame.NOT_IN_MATCH_DESC,
                color: 0x616161,
                footer: { text: s(userId).livegame.LIVE_GAME_FOOTER },
            }],
            components: [liveGameRefreshRow(userId)],
        };
    }

    const embed = await buildGameEmbed(liveGameData, allyPlayers, enemyPlayers, channel, userId);

    return {
        embeds: [embed],
        components: [liveGameRefreshRow(userId)],
    };
};

/**
 * Render an error/auth-failure message for the livegame command.
 *
 * @param {object}       liveGameData
 * @param {string|null}  userId  Discord user ID — when provided, includes a
 *                               Refresh button so the user can retry.
 */
export const renderLiveGameError = (liveGameData, userId = null) => {
    const components = userId ? [liveGameRefreshRow(userId)] : [];

    if (liveGameData.maintenance) {
        return {
            embeds: [{
                title: s().livegame.MAINTENANCE_TITLE,
                description: s().livegame.MAINTENANCE_DESC,
                color: 0x616161,
            }],
            components,
        };
    }
    if (liveGameData.rateLimit) {
        return {
            embeds: [{
                title: s().livegame.RATE_LIMITED_TITLE,
                description: s().livegame.RATE_LIMITED_DESC,
                color: 0xBF360C,
            }],
            components,
        };
    }
    return {
        embeds: [{
            title: s().livegame.LOGIN_REQUIRED_TITLE,
            description: s().livegame.LOGIN_REQUIRED_DESC,
            color: 0x616161,
        }],
        components,
    };
};
