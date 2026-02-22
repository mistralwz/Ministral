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

// ─── Colours ────────────────────────────────────────────────────────────────
const COLOR_PREGAME = 0xFFB300;  // amber  — agent select
const COLOR_ALLY    = 0x1E88E5;  // blue   — in-game

// ─── State labels ────────────────────────────────────────────────────────────
const STATE_LABEL = {
    pregame:     "🟡 Agent Select",
    ingame:      "🔴 In-Game",
    not_in_game: "⬜ Not in a match",
};

// ─── Emoji maps ──────────────────────────────────────────────────────────────

/** Agent display-name → Discord custom emoji string */
const AGENT_EMOJIS = {
    "Astra":     "<:Agent_Astra:818987103022743562>",
    "Breach":    "<:Agent_Breach:1188264724681466016>",
    "Brimstone": "<:Agent_Brimstone:1188264726115913769>",
    "Chamber":   "<:Agent_Chamber:1166782015870341200>",
    "Clove":     "<:Agent_Clove:1221946587920732272>",
    "Cypher":    "<:Agent_Cypher:1188264919825645619>",
    "Deadlock":  "<:Agent_Deadlock:1123637948844359791>",
    "Fade":      "<:Agent_Fade:1112816425879486534>",
    "Gekko":     "<:Agent_Gekko:1166782019850739763>",
    "Harbor":    "<:Agent_Harbor:1112816419860652122>",
    "Jett":      "<:Agent_Jett:1188264922614865970>",
    "KAY/O":     "<:Agent_KAYO:1188264923730550867>",
    "Killjoy":   "<:Agent_Killjoy:1188264927631257662>",
    "Neon":      "<:Agent_Neon:1188264929346715678>",
    "Omen":      "<:Agent_Omen:1188264932584738826>",
    "Phoenix":   "<:Agent_Phoenix:1188264934207913984>",
    "Raze":      "<:Agent_Raze:1188264937110392883>",
    "Reyna":     "<:Agent_Reyna:1188264938943283270>",
    "Sage":      "<:Agent_Sage:1188264941657002005>",
    "Skye":      "<:Agent_Skye:1166782165376303164>",
    "Sova":      "<:Agent_Sova:1188264943280197692>",
    "Tejo":      "<:Agent_Tejo:1353619441417715887>",
    "Veto":      "<:Agent_Veto:1457742882617168070>",
    "Viper":     "<:Agent_Viper:1188264946203635753>",
    "Vyse":      "<:Agent_Vyse:1280172841102213220>",
    "Waylay":    "<:Agent_Waylay:1346197177009176648>",
    "Yoru":      "<:Agent_Yoru:1188264947885559888>",
};

/**
 * Competitive tier number → Discord custom emoji string.
 * Tier numbers follow the Valorant API (3–5 Iron, 6–8 Bronze, … 27 Radiant).
 */
const RANK_EMOJIS = {
     3: "<:iron1:862004162098102272>",
     4: "<:iron2:862004185036488715>",
     5: "<:iron3:862004206718025738>",
     6: "<:bronze1:862004343054008331>",
     7: "<:bronze2:862004376272109608>",
     8: "<:bronze3:862004410775371777>",
     9: "<:silver1:862004807896268832>",
    10: "<:silver2:862004860655501342>",
    11: "<:silver3:862004895708086302>",
    12: "<:gold1:862004921763364874>",
    13: "<:gold2:862004943708094525>",
    14: "<:gold3:862004966636781608>",
    15: "<:plat1:862005172687470622>",
    16: "<:plat2:862005201301143573>",
    17: "<:plat3:862005224645853185>",
    18: "<:dia1:862005255628652554>",
    19: "<:dia2:862005278207508551>",
    20: "<:dia3:862005298193891378>",
    21: "<:ascendant1:987519801868025886>",
    22: "<:ascendant2:987519799590522920>",
    23: "<:ascendant3:987519800521662525>",
    24: "<:immortal1:862005437264429056>",
    25: "<:immortal2:862005462580985856>",
    26: "<:immortal3:862005493840478208>",
    27: "<:radiant:862005538392506408>",
};

/** Unranked players get this emoji instead of a rank badge */
const UNRATED_EMOJI = "<:unrated:862004031248924693>";

// ─── Player row renderer ─────────────────────────────────────────────────────

/**
 * Render one player as a single compact line, placed in the field VALUE.
 *
 * Format (all modes):
 *   **level**┊<agent>  `RiotId`・<rank> **42 RR**・<peak> (E5A3)
 *
 * Competitive also appends:
 *   ・**46%WR** (13)・🟢🔴🟢
 *
 * Level is always shown — **?** when hidden or unavailable.
 * Peak rank is always shown when the player has competitive history.
 *
 * @param {object}  player
 * @param {boolean} isCompetitive  Show WR + match dots when true
 */
const formatPlayerRow = (player, isCompetitive = false) => {
    // Level — always shown; "?" when hidden or unavailable
    const levelStr = (player.levelHidden || player.accountLevel == null)
        ? "**?**"
        : `**${player.accountLevel}**`;

    const agentEmoji = player.agentName
        ? (AGENT_EMOJIS[player.agentName] ?? `\`${player.agentName}\``)
        : `\`—\``;

    // Current rank
    const rankPart = player.currentTier > 0
        ? `${RANK_EMOJIS[player.currentTier] ?? ""} **${player.currentRR} RR**`
        : UNRATED_EMOJI;

    // Peak rank — shown in all modes with act label when available
    const peakEmoji = player.peakTier > 0 ? (RANK_EMOJIS[player.peakTier] ?? "") : null;
    const peakPart  = peakEmoji
        ? `${peakEmoji}${player.peakActLabel ? ` (${player.peakActLabel})` : ""}`
        : null;

    // Competitive-only: win-rate and last 3 match dots
    const compParts = [];
    if (isCompetitive) {
        if (player.winRate !== null)
            compParts.push(`**${player.winRate}%WR** (${player.games})`);
        if (player.recentMatches?.length)
            compParts.push(player.recentMatches.map(m => m.win ? "🟢" : "🔴").join(""));
    }

    return [
        `${levelStr}┊${agentEmoji}  \`${player.riotId}\``,
        rankPart,
        peakPart,
        ...compParts,
    ].filter(Boolean).join("・");
};

/**
 * Build embed fields for a list of players.
 * Each player occupies its own field (empty name + player line as value).
 */
const buildPlayerFields = (players, isCompetitive) =>
    players.map(p => ({
        name:   "\u200b",
        value:  formatPlayerRow(p, isCompetitive),
        inline: false,
    }));

// ─── Single embed builder ─────────────────────────────────────────────────────

/**
 * Build the single embed for any game state.
 *
 * • Two-team modes  → ally player fields, then a divider, then enemy fields.
 * • Single-team modes (deathmatch, …) → all players listed in `description`.
 */
const buildGameEmbed = (data, allyPlayers, enemyPlayers) => {
    const stateLabel   = STATE_LABEL[data.state] ?? "Live Game";
    const isPreGame    = data.state === "pregame";
    const isCompetitive = data.queueId === "competitive";
    const color        = isPreGame ? COLOR_PREGAME : COLOR_ALLY;

    const embed = {
        title:     `⚔️ Live Game・${data.mapName}`,
        color,
        thumbnail: data.queueIcon ? { url: data.queueIcon } : undefined,
        image:     data.mapImage  ? { url: data.mapImage }  : undefined,
        footer:    { text: `${stateLabel}・${data.queueName}` },
        timestamp: new Date().toISOString(),
    };

    if (data.isSingleTeam) {
        // Free-for-all: description block, one player per line
        embed.description = [...allyPlayers, ...enemyPlayers]
            .map(p => formatPlayerRow(p, isCompetitive))
            .join("\n");
    } else {
        // Two-team layout via fields
        const allyFields  = buildPlayerFields(allyPlayers,  isCompetitive);
        const enemyFields = buildPlayerFields(enemyPlayers, isCompetitive);

        embed.fields = [
            ...allyFields,
            ...(enemyFields.length ? [
                { name: "── Enemy Team ──", value: "\u200b", inline: false },
                ...enemyFields,
            ] : []),
        ];
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
            .setLabel("Refresh")
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
 * @returns Discord message payload { embeds, components }
 */
export const renderLiveGame = (liveGameData, userId, _isDM = false) => {
    const { state, allyPlayers = [], enemyPlayers = [] } = liveGameData;

    if (state === "not_in_game") {
        return {
            embeds: [{
                title:       "Not in a Match",
                description: "You don't appear to be in a pre-game lobby or a live match right now.\n\nMake sure you're currently in **agent select** or **in-game** and try again.",
                color:       0x616161,
                footer:      { text: "Live Game" },
            }],
            components: [liveGameRefreshRow(userId)],
        };
    }

    const embed = buildGameEmbed(liveGameData, allyPlayers, enemyPlayers);

    return {
        embeds:     [embed],
        components: [liveGameRefreshRow(userId)],
    };
};

/**
 * Render an error/auth-failure message for the livegame command.
 */
export const renderLiveGameError = (liveGameData) => {
    if (liveGameData.maintenance) {
        return {
            embeds: [{
                title:       "Valorant Maintenance",
                description: "Valorant servers are currently under maintenance. Try again later.",
                color:       0x616161,
            }],
        };
    }
    if (liveGameData.rateLimit) {
        return {
            embeds: [{
                title:       "Rate Limited",
                description: "You are currently rate-limited. Please wait a moment and try again.",
                color:       0xBF360C,
            }],
        };
    }
    return {
        embeds: [{
            title:       "Login Required",
            description: "Could not verify your Valorant account. Please log in again with `/login`.",
            color:       0x616161,
        }],
    };
};
