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

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder } from "discord.js";
import { s, discToValLang, DEFAULT_VALORANT_LANG } from "../misc/languages.js";
import { getSetting } from "../misc/settings.js";
import config from "../misc/config.js";
import { getUser } from "../valorant/auth.js";
import { resolveAgent, getOwnedAgents, resolveQueueName, resolveQueueIcon, resolveServerName, resolveTier } from "../valorant/livegame.js";
import { agentEmoji, rankEmoji, queueEmoji, emojiToString } from "./emoji.js";
import { getRankColor } from "./embed.js";

const roleSelections = new Map();
export const setRoleSelection = (userId, role) => roleSelections.set(userId, role);

// ─── Colours ────────────────────────────────────────────────────────────────
const COLOR_PREGAME = 0xFFB300;   // amber   — agent select & queuing
const COLOR_ALLY = 0x1E88E5;      // blue    — in-game ally
const COLOR_ENEMY = 0xFD4553;     // red     — in-game enemy
const COLOR_PARTY = 0x5865F2;     // blurple — idle party
const COLOR_OFFLINE = 0x2B2D31;   // dark    — offline / neutral
const COLOR_WARNING = 0xF59E0B;   // warning — maintenance
const COLOR_ERROR = 0xED4245;     // red     — rate limited

// ─── State labels ────────────────────────────────────────────────────────────
const STATE_LABEL = {
    pregame: "🟡 Agent Select",
    ingame: "🔴 In-Game",
    not_in_game: "⬜ Not in a match",
    queuing: "🕒 Queuing",
};

// ─── Server Flags Mapping ───────────────────────────────────────────────────
const SERVER_FLAGS = {
    // Americas
    "Ashburn": "🇺🇸", "Atlanta": "🇺🇸", "Georgia": "🇺🇸", "Chicago": "🇺🇸", "Illinois": "🇺🇸",
    "Dallas": "🇺🇸", "Texas": "🇺🇸", "Virginia": "🇺🇸", "California": "🇺🇸", "N. California": "🇺🇸",
    "Oregon": "🇺🇸", "Miami": "🇺🇸", "Santiago": "🇨🇱", "Mexico City": "🇲🇽", "Bogota": "🇨🇴", "Bogotá": "🇨🇴", "Sao Paulo": "🇧🇷",
    // Europe, Middle East & Africa
    "Frankfurt": "🇩🇪", "London": "🇬🇧", "Paris": "🇫🇷", "Madrid": "🇪🇸",
    "Stockholm": "🇸🇪", "Warsaw": "🇵🇱", "Istanbul": "🇹🇷", "Bahrain": "🇧🇭", "Dubai": "🇦🇪", "Cape Town": "🇿🇦",
    // Asia & Pacific
    "Tokyo": "🇯🇵", "Seoul": "🇰🇷", "Hong Kong": "🇭🇰", "Singapore": "🇸🇬",
    "Sydney": "🇦🇺", "Mumbai": "🇮🇳", "Manila": "🇵🇭", "Bangkok": "🇹🇭",
    "Beijing": "🇨🇳", "Shanghai": "🇨🇳", "Guangzhou": "🇨🇳", "Nanjing": "🇨🇳", "Tianjin": "🇨🇳", "Chongqing": "🇨🇳",
};

/** Format a single server name with its flag emoji. */
export const formatServerName = (serverName) => {
    if (!serverName) return "";
    const clean = serverName.replace(/^US (East|Central|West) \((.+)\)$/, '$2').replace(/ \d+$/, '');
    const flag = serverName.startsWith("US ") ? "🇺🇸" : (SERVER_FLAGS[clean] || SERVER_FLAGS[serverName] || "");
    return flag ? `${flag} ${clean}` : clean;
};

/**
 * Formats a list of preferred game pods into a flag-grouped string.
 *
 * Rules:
 * - 0 servers / empty: `Auto`
 * - 1 server total: `${flag} ${name}` (e.g. `🇩🇪 Frankfurt` or `🇺🇸 Virginia`)
 * - 2-3 servers total:
 *   - Grouped by country: `${flag} ${name1, name2}` (e.g. `🇺🇸 Virginia, Texas` or `🇩🇪 Frankfurt・🇬🇧 London`)
 * - >3 servers total:
 *   - If all from same country: `${flag} ${name1, name2, ...}`
 *   - If across multiple countries: compact flags only `🇸🇬 🇯🇵 🇦🇺 🇮🇳 🇭🇰`
 */
export const formatPreferredServers = (preferredGamePods, autoText = "Auto") => {
    if (!preferredGamePods?.length) return `\`${autoText}\``;

    const pods = preferredGamePods.map(pod => {
        const raw = resolveServerName(pod);
        const name = raw.replace(/^US (East|Central|West) \((.+)\)$/, '$2').replace(/ \d+$/, '');
        const flag = raw.startsWith("US ") ? "🇺🇸" : (SERVER_FLAGS[name] || "");
        return { name, flag };
    });

    const unique = [];
    const seen = new Set();
    for (const p of pods) {
        const key = `${p.flag}:${p.name}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(p);
        }
    }

    if (unique.length === 0) return `\`${autoText}\``;

    const groups = new Map();
    for (const item of unique) {
        const key = item.flag || item.name;
        if (!groups.has(key)) groups.set(key, { flag: item.flag, names: [] });
        groups.get(key).names.push(item.name);
    }

    if (unique.length === 1) {
        const item = unique[0];
        return item.flag ? `${item.flag} ${item.name}` : item.name;
    }

    if (unique.length <= 3) {
        return [...groups.values()]
            .map(g => g.flag ? `${g.flag} ${g.names.join(", ")}` : g.names.join(", "))
            .join("・");
    }

    if (groups.size === 1) {
        const [g] = groups.values();
        return g.flag ? `${g.flag} ${g.names.join(", ")}` : g.names.join(", ");
    }

    const flags = [...groups.values()].map(g => g.flag || g.names[0]);
    return flags.join(" ");
};

// ─── Player match row renderer ─────────────────────────────────────────────

/**
 * Render one player as a compact 2-line markdown block.
 *
 * Line 1 (Header):
 *   <agent> `RiotName` <rank>**42**rr <peak>`E5A3`
 *
 * Line 2 (Subtext):
 *   -# **152** ADR・**1.18** K/D・**28%** HS・**54%** Win `230` `🔹🔻🔹`
 *
 * @param {object}  player
 * @param {Channel} channel       Discord channel (for emoji resolution)
 * @param {boolean} showCompStats Show WR + last 3 match results when true
 * @param {string}  valLang       Valorant language code (e.g. en-US, ja-JP)
 * @param {string}  userId        Discord user ID for localized text
 */
export const formatPlayerRow = async (player, channel, showCompStats = false, valLang = DEFAULT_VALORANT_LANG, userId = null) => {
    const localizedAgentName = player.agentName ? (player.agentName[valLang] || player.agentName["en-US"] || "Unknown") : null;
    const enAgentName = player.agentName ? (player.agentName["en-US"] || "Unknown") : null;

    let displayName;
    if (player.incognito) {
        if (localizedAgentName && (player.selectionState === "locked" || player.selectionState === undefined)) {
            displayName = localizedAgentName;
        } else {
            const template = s(userId).livegame?.PLAYER_NUM || "Player {n}";
            displayName = template.replace("{n}", player.playerIndex || "1");
        }
    } else {
        displayName = (player.riotId || "Unknown").split('#')[0];
    }

    const guildId = channel?.guildId || channel?.guild?.id || "@me";
    const channelId = channel?.id || "0";
    const channelUrl = `https://discord.com/channels/${guildId}/${channelId}/#`;
    const safeRiotId = player.riotId ? player.riotId.replace(/"/g, "'") : "";
    const nameToken = (!player.incognito && safeRiotId)
        ? `[\`${displayName}\`](${channelUrl} "${safeRiotId}")`
        : `\`${displayName}\``;

    let agentEmojiStr = "";
    if (enAgentName && player.agentIcon) {
        agentEmojiStr = emojiToString(await agentEmoji(enAgentName, player.agentIcon)) ?? (player.incognito ? "" : `\`${localizedAgentName}\``);
    } else if (player.incognito) {
        agentEmojiStr = "";
    } else if (localizedAgentName) {
        agentEmojiStr = `\`${localizedAgentName}\``;
    }

    // Current rank emoji — tier 0 (Unranked) now has an icon too
    const currentRankEmojiStr = player.currentTierIcon
        ? (emojiToString(await rankEmoji(player.currentTier, player.currentTierIcon)) ?? "")
        : "";

    // Peak rank — badge before act label: <peak_badge> `E5A3`
    const peakRankEmojiStr = player.peakTier > 0 && player.peakTierIcon
        ? (emojiToString(await rankEmoji(player.peakTier, player.peakTierIcon)) ?? (player.peakTierName ? `\`${player.peakTierName}\`` : ""))
        : "";
    const peakBadgePart = (peakRankEmojiStr && player.peakActLabel)
        ? `${peakRankEmojiStr} \`${player.peakActLabel}\``
        : (peakRankEmojiStr || "");

    const agentPrefix = agentEmojiStr ? `${agentEmojiStr} ` : "";
    const leaderBadge = player.isLeader ? "👑 " : "";

    const rankBadgePart = player.currentTier > 0
        ? (player.isRankFallback && !player.peakTier && player.winRate == null && player.adr == null
            ? `${currentRankEmojiStr}\`${player.currentTierName}\``.trim()
            : `${currentRankEmojiStr} **${player.currentRR}**rr`.trim())
        : (currentRankEmojiStr ? `${currentRankEmojiStr} \`Unranked\`` : "`Unranked`");

    const line1 = `${agentPrefix}${leaderBadge}${nameToken} ${rankBadgePart} ${peakBadgePart}`.trim();

    // Value items: ADR, K/D/A Ratio, Headshot %, Win% (fallback to 0 when no stats available)
    const adr = player.adr ?? 0;
    const kd = player.kd ?? "0";
    const hs = player.hs ?? 0;
    const winRate = player.winRate ?? 0;
    const gameCount = player.games ? ` \`${player.games}\`` : "";

    const statItems = [
        `**${adr}** ADR`,
        `**${kd}** K/D`,
        `**${hs}%** HS`,
        `**${winRate}%** Win${gameCount}`
    ];

    let recentMatchesStr = "";
    if (player.recentMatches && player.recentMatches.length > 0) {
        const symbols = player.recentMatches.map(m => {
            if (m === "win") return "🔹";
            if (m === "loss") return "🔻";
            return "▫️";
        }).join("");
        recentMatchesStr = ` \`${symbols}\``;
    }

    const line2 = `-# ${statItems.join("・")}${recentMatchesStr}`;

    return `${line1}\n${line2}`;
};

/**
 * Calculate average rank, average peak rank, and matching embed color across players.
 */
export const calculateLobbyRank = async (players) => {
    if (!players || players.length === 0) return { avgRankQuote: "", color: null };

    const rankedPlayers = players.filter(p => p.currentTier > 0);
    const peakPlayers = players.filter(p => p.peakTier > 0);

    let avgRankStr = "";
    let lobbyColor = null;

    if (rankedPlayers.length > 0) {
        const avgCurrentTier = Math.round(rankedPlayers.reduce((sum, p) => sum + p.currentTier, 0) / rankedPlayers.length);
        const avgCurrentRR = Math.round(rankedPlayers.reduce((sum, p) => sum + (p.currentRR || 0), 0) / rankedPlayers.length);
        const avgTierInfo = await resolveTier(avgCurrentTier);
        const avgRankEmoji = emojiToString(await rankEmoji(avgCurrentTier, avgTierInfo.icon)) ?? "";
        avgRankStr = `${avgRankEmoji ? `${avgRankEmoji} ` : ""}**${avgTierInfo.name}** (${avgCurrentRR} RR)`.trim();
        lobbyColor = getRankColor(avgTierInfo.name);
    }

    let avgPeakStr = "";
    if (peakPlayers.length > 0) {
        const avgPeakTier = Math.round(peakPlayers.reduce((sum, p) => sum + p.peakTier, 0) / peakPlayers.length);
        const avgPeakTierInfo = await resolveTier(avgPeakTier);
        const avgPeakRankEmoji = emojiToString(await rankEmoji(avgPeakTier, avgPeakTierInfo.icon)) ?? "";
        avgPeakStr = `${avgPeakRankEmoji ? `${avgPeakRankEmoji} ` : ""}**${avgPeakTierInfo.name}**`.trim();
        if (!lobbyColor) lobbyColor = getRankColor(avgPeakTierInfo.name);
    }

    const parts = [];
    if (avgRankStr) parts.push(`**Avg. Rank:** ${avgRankStr}`);
    if (avgPeakStr) parts.push(`**Peak Rank:** ${avgPeakStr}`);

    const avgRankQuote = parts.length > 0 ? `> ${parts.join(" ┊ ")}` : "";
    return { avgRankQuote, color: lobbyColor };
};

/**
 * Format a list of players into a unified markdown block for embed descriptions.
 */
export const formatPlayersBlock = async (players, channel, showCompStats, valLang = DEFAULT_VALORANT_LANG, userId = null) => {
    if (!players || players.length === 0) return "";
    const lines = await Promise.all(players.map(p =>
        formatPlayerRow(p, channel, showCompStats, valLang, userId)
    ));
    return lines.join("\n");
};

const resolveTeamColor = (players, fallbackColor, isPreGame = false) => {
    if (isPreGame) return COLOR_PREGAME;
    const teamId = players?.[0]?.teamId?.toLowerCase();
    if (teamId === "blue") return COLOR_ALLY; // 0x1E88E5 (Blue / Defense)
    if (teamId === "red") return COLOR_ENEMY;  // 0xFD4553 (Red / Attack)
    return fallbackColor;
};

// ─── Game embed builders ─────────────────────────────────────────────────────

/**
 * Build the single unified embed for any game state.
 * Both ally and enemy players are formatted in the description with one line gap between teams.
 */
const buildGameEmbeds = async (data, allyPlayers, enemyPlayers, channel, userId = null, valLang = DEFAULT_VALORANT_LANG) => {
    const stateLabel = STATE_LABEL[data.state] ?? "Live Game";
    const isPreGame = data.state === "pregame";
    const showCompStats = data.queueId === "competitive" || data.queueId === "skirmish" || data.queueId === "skirmish 2v2";
    const defaultColor = resolveTeamColor(allyPlayers, COLOR_ALLY, isPreGame);

    const formattedServer = formatServerName(data.serverName);
    const mapAndServer = formattedServer
        ? `${data.mapName}・${formattedServer}`
        : data.mapName;

    const isTeamGame = !data.isSingleTeam && enemyPlayers && enemyPlayers.length > 0;
    const allPlayers = isTeamGame ? [...allyPlayers, ...enemyPlayers] : allyPlayers;

    const [{ avgRankQuote, color: rankColor }, allyBlock, enemyBlock] = await Promise.all([
        calculateLobbyRank(allPlayers),
        formatPlayersBlock(allyPlayers, channel, showCompStats, valLang, userId),
        isTeamGame
            ? formatPlayersBlock(enemyPlayers, channel, showCompStats, valLang, userId)
            : Promise.resolve(""),
    ]);

    const descParts = [];
    if (config.notice) descParts.push(config.notice);
    if (avgRankQuote) descParts.push(avgRankQuote);
    if (allyBlock) descParts.push(allyBlock);
    if (enemyBlock) descParts.push(enemyBlock);

    const gameEmbed = {
        author: {
            name: `${data.queueName}・${mapAndServer}`,
            icon_url: data.queueIcon ?? undefined,
        },
        description: descParts.length > 0 ? descParts.join("\n\n") : undefined,
        color: rankColor || defaultColor,
        footer: { text: stateLabel },
        timestamp: new Date().toISOString(),
    };

    return [gameEmbed];
};

// ─── Refresh & Action buttons ─────────────────────────────────────────────

/**
 * Returns the action row with Refresh and Join Party buttons.
 * customId format: `livegame/refresh/{userId}`
 */
export const liveGameRefreshRow = (userId, inviteCode = null, isLobby = false) => {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`livegame/refresh/${userId}`)
            .setLabel(s(userId).livegame?.REFRESH_BUTTON || "Refresh")
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Secondary)
    );

    if (isLobby) {
        if (inviteCode) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`livegame/join_party/${inviteCode}`)
                    .setLabel(s(userId).livegame?.JOIN_PARTY || "Join the Party")
                    .setEmoji("🔓")
                    .setStyle(ButtonStyle.Success)
            );
        } else {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId("livegame/join_party/closed")
                    .setLabel(s(userId).livegame?.PARTY_CLOSED || "Party Closed")
                    .setEmoji("🔒")
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
        }
    }

    return row;
};

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

    let discLang = config.localiseText ? getSetting(userId, 'locale') : 'en-GB';
    if (discLang === "Automatic") discLang = 'en-US';
    const valLang = discToValLang[discLang] || DEFAULT_VALORANT_LANG;

    if (state === "not_in_game" || state === "queuing") {
        roleSelections.delete(userId);
        const hasParty = allyPlayers && allyPlayers.length > 0;

        let title, statusText, color, author = undefined;
        const qUpper = liveGameData.queueId?.toUpperCase() || "CUSTOM";
        const dictQ = (s(userId).queues && qUpper in s(userId).queues) ? s(userId).queues[qUpper] : undefined;
        const localizedQueueNameQueueing = dictQ || resolveQueueName(liveGameData.queueId, valLang);
        const serverFormatted = formatPreferredServers(liveGameData.preferredGamePods, s(userId).livegame?.AUTO_SERVERS || "Auto");

        if (state === "queuing") {
            author = {
                name: localizedQueueNameQueueing,
                icon_url: resolveQueueIcon(liveGameData.queueId) ?? undefined,
            };
            title = s(userId).livegame.QUEUING_TITLE;
            statusText = `🔍 ${s(userId).livegame.QUEUING_DESC.f({ queueName: localizedQueueNameQueueing })}`;
            color = COLOR_PREGAME;
        } else {
            if (hasParty) {
                title = `👥 ${s(userId).livegame.IDLE_PARTY_TITLE || "Idle in Party"}`;
                statusText = `⏳ ${s(userId).livegame.IDLE_PARTY_DESC || "Waiting to queue."}`;
                color = COLOR_PARTY;
            } else {
                title = `💤 ${s(userId).livegame.NOT_IN_MATCH_TITLE}`;
                statusText = `🎮 ${s(userId).livegame.NOT_IN_MATCH_DESC}`;
                color = COLOR_OFFLINE;
            }
        }

        const { avgRankQuote, color: rankColor } = hasParty ? await calculateLobbyRank(allyPlayers) : { avgRankQuote: "", color: null };

        const headerLines = [];
        if (config.notice) headerLines.push(config.notice);
        if (avgRankQuote) headerLines.push(avgRankQuote);
        if (statusText) headerLines.push(statusText);
        if (serverFormatted) headerLines.push(`-# 🌐 **Servers:** ${serverFormatted}`);
        if (liveGameData.inviteCode) {
            headerLines.push(`-# 🔑 **${s(userId).livegame?.PARTY_CODE || "Party Code"}** \`${liveGameData.inviteCode}\``);
        }

        const descriptionParts = [];
        if (headerLines.length > 0) descriptionParts.push(headerLines.join("\n"));
        if (hasParty) {
            const playerBlock = await formatPlayersBlock(allyPlayers, channel, true, valLang, userId);
            if (playerBlock) descriptionParts.push(playerBlock);
        }
        const description = descriptionParts.length > 0 ? descriptionParts.join("\n\n") : undefined;

        const embed = {
            author,
            title,
            description,
            color: (hasParty && rankColor) || color,
        };

        let components = [liveGameRefreshRow(userId, liveGameData.inviteCode, hasParty)];

        // UI Controls for party leader
        if (hasParty && liveGameData.matchId) {
            const myPlayer = allyPlayers.find(p => p.puuid === liveGameData.userPuuid);
            if (myPlayer && myPlayer.isLeader) {
                let queueButton;
                if (state === "queuing") {
                    queueButton = new ButtonBuilder()
                        .setCustomId(`livegame/cancel_queue/${liveGameData.matchId}`)
                        .setLabel(s(userId).livegame.CANCEL_QUEUE)
                        .setStyle(ButtonStyle.Danger);
                } else {
                    queueButton = new ButtonBuilder()
                        .setCustomId(`livegame/start_queue/${liveGameData.matchId}`)
                        .setLabel(s(userId).livegame.START_QUEUE)
                        .setStyle(ButtonStyle.Success);
                }

                const buttonRow = new ActionRowBuilder().addComponents(queueButton);

                if (liveGameData.inviteCode) {
                    const removeCodeButton = new ButtonBuilder()
                        .setCustomId(`livegame/remove_code/${liveGameData.matchId}`)
                        .setLabel(s(userId).livegame.REMOVE_PARTY_CODE)
                        .setStyle(ButtonStyle.Danger);
                    buttonRow.addComponents(removeCodeButton);
                } else {
                    const codeButton = new ButtonBuilder()
                        .setCustomId(`livegame/make_code/${liveGameData.matchId}`)
                        .setLabel(s(userId).livegame.GENERATE_PARTY_CODE)
                        .setStyle(ButtonStyle.Secondary);
                    buttonRow.addComponents(codeButton);
                }

                components.unshift(buttonRow);

                if (state === "not_in_game" && liveGameData.eligibleQueues && liveGameData.eligibleQueues.length > 0) {
                    let allQueues = [...new Set(liveGameData.eligibleQueues)];
                    const isCurrentlyCustom = liveGameData.queueId === "" || liveGameData.queueId === "custom";
                    if (isCurrentlyCustom && !allQueues.includes("custom")) {
                        allQueues.push("custom");
                    } else if (!isCurrentlyCustom) {
                        allQueues = allQueues.filter(q => q !== "custom");
                    }
                    const queueOptions = await Promise.all(allQueues
                        .map(async q => {
                            const icon = resolveQueueIcon(q);
                            const qUpper = q.toUpperCase();
                            const dictQ = (s(userId).queues && qUpper in s(userId).queues) ? s(userId).queues[qUpper] : undefined;
                            const localizedQueueName = dictQ || resolveQueueName(q, valLang);
                            const emojiData = await queueEmoji(q, icon);
                            return {
                                label: localizedQueueName,
                                value: q,
                                default: q === liveGameData.queueId,
                                emoji: emojiData ? { id: emojiData.id, name: emojiData.name, animated: emojiData.animated } : undefined
                            };
                        }));

                    if (queueOptions.length > 0) {
                        const queueSelectRow = new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId(`livegame/select_queue/${liveGameData.matchId}`)
                                .setPlaceholder("Select a Mode")
                                .addOptions(queueOptions.slice(0, 25))
                        );
                        components.unshift(queueSelectRow);
                    }
                }
            }
        }

        return { embeds: [embed], components };
    }

    const embeds = await buildGameEmbeds(liveGameData, allyPlayers, enemyPlayers, channel, userId, valLang);

    let components = [liveGameRefreshRow(userId)];

    if (state === "pregame" && liveGameData.matchId) {
        const myPlayer = allyPlayers.find(p => p.puuid === liveGameData.userPuuid);

        if (myPlayer && myPlayer.selectionState !== "locked") {
            const ownedAgentIds = await getOwnedAgents(getUser(userId));

            const lockedAgentIds = new Set(
                allyPlayers.filter(p => p.selectionState === "locked").map(p => p.agentId?.toLowerCase())
            );

            const options = [];
            for (const agentId of ownedAgentIds) {
                if (lockedAgentIds.has(agentId)) continue;

                const agentInfo = await resolveAgent(agentId);
                if (!agentInfo || agentInfo.roles === null) continue;

                const emojiObj = await agentEmoji(agentInfo.names["en-US"] || "Unknown", agentInfo.icon);

                options.push({
                    label: agentInfo.names[valLang] || agentInfo.names["en-US"] || "Unknown",
                    value: agentId,
                    default: agentId === myPlayer.agentId?.toLowerCase(),
                    role: agentInfo.roles["en-US"] || "Unknown",
                    roleLocalized: agentInfo.roles[valLang] || agentInfo.roles["en-US"] || "Unknown",
                    roleIcon: agentInfo.roleIcon,
                    description: agentInfo.roles[valLang] || agentInfo.roles["en-US"] || "Unknown",
                    emoji: emojiObj?.id ? { id: emojiObj.id } : undefined
                });
            }

            options.sort((a, b) => a.label.localeCompare(b.label));

            const menuRows = [];

            // 1. Uniquely identify each role
            const uniqueRoles = new Map();
            for (const opt of options) {
                if (!uniqueRoles.has(opt.role)) {
                    uniqueRoles.set(opt.role, {
                        roleLocalized: opt.roleLocalized,
                        roleIcon: opt.roleIcon
                    });
                }
            }

            const roleNames = [...uniqueRoles.keys()].sort();
            const selectedRole = roleSelections.get(userId);

            // 2. Build the Role Dropdown Options
            const roleOptions = [];
            for (const r of roleNames) {
                const info = uniqueRoles.get(r);
                const roleEmojiObj = await agentEmoji("Role_" + r, info.roleIcon);

                roleOptions.push({
                    label: info.roleLocalized,
                    value: r,
                    default: r === selectedRole,
                    emoji: roleEmojiObj?.id ? { id: roleEmojiObj.id } : undefined
                });
            }

            if (roleOptions.length > 0) {
                menuRows.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`livegame/select_role/${liveGameData.matchId}`)
                        .setPlaceholder(s(userId).livegame?.SELECT_AGENT_PLACEHOLDER || "Select a Role")
                        .addOptions(roleOptions.slice(0, 25))
                ));
            }

            // 3. Conditionally build the Agent dropdown if a Role is selected
            if (selectedRole && roleNames.includes(selectedRole)) {
                const agentOptions = options.filter(o => o.role === selectedRole);
                if (agentOptions.length > 0) {
                    menuRows.push(new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`livegame/select_agent/${liveGameData.matchId}/0`)
                            .setPlaceholder(`Select an Agent (${uniqueRoles.get(selectedRole).roleLocalized})`)
                            .addOptions(agentOptions.slice(0, 25))
                    ));
                }
            }

            if (menuRows.length > 0) {
                components = [...menuRows, components[0]];
            }
        }
    }

    return {
        embeds,
        components,
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
    const strings = s(userId).livegame;

    if (liveGameData.maintenance) {
        return {
            embeds: [{
                title: `🛠️ ${strings.MAINTENANCE_TITLE}`,
                description: strings.MAINTENANCE_DESC,
                color: COLOR_WARNING,
            }],
            components,
            flags: [MessageFlags.Ephemeral]
        };
    }
    if (liveGameData.rateLimit) {
        return {
            embeds: [{
                title: `⏳ ${strings.RATE_LIMITED_TITLE}`,
                description: strings.RATE_LIMITED_DESC,
                color: COLOR_ERROR,
            }],
            components,
            flags: [MessageFlags.Ephemeral]
        };
    }
    return {
        embeds: [{
            title: `🔐 ${strings.LOGIN_REQUIRED_TITLE}`,
            description: strings.LOGIN_REQUIRED_DESC,
            color: COLOR_OFFLINE,
        }],
        components,
        flags: [MessageFlags.Ephemeral]
    };
};
