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
import { resolveAgent, getOwnedAgents, resolveQueueName, resolveQueueIcon, resolveServerName } from "../valorant/livegame.js";
import { agentEmoji, rankEmoji, queueEmoji, emojiToString } from "./emoji.js";

const roleSelections = new Map();
export const setRoleSelection = (userId, role) => roleSelections.set(userId, role);

// ─── Colours ────────────────────────────────────────────────────────────────
const COLOR_PREGAME = 0xFFB300;   // amber   — agent select & queuing
const COLOR_ALLY = 0x1E88E5;      // blue    — in-game ally
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

// ─── Party Color Emojis ─────────────────────────────────────────────────────
const PARTY_EMOJIS = ["🟥", "🟧", "🟨", "🟩", "🟦"];

/** Assign color emojis to parties with >=2 members in the team. */
const getPartyColorMap = (players) => {
    const counts = new Map();
    for (const p of players) if (p.partyId) counts.set(p.partyId, (counts.get(p.partyId) || 0) + 1);

    const colors = new Map();
    let idx = 0;
    for (const p of players) {
        if (p.partyId && counts.get(p.partyId) >= 2 && !colors.has(p.partyId)) {
            colors.set(p.partyId, PARTY_EMOJIS[idx++ % PARTY_EMOJIS.length]);
        }
    }
    return colors;
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

// ─── Player row renderer ─────────────────────────────────────────────────────

/**
 * Render one player as a single compact line.
 *
 * Format (all modes):
 *   [PartyEmoji] <agent> `RiotName`・<rank>**42**rr・<peak>`E5A3`
 *
 * Competitive also appends:
 *   ・**46%**wr `13`・`🔹🔹🔻🔹🔹`
 *
 * @param {object}  player
 * @param {Channel} channel       Discord channel (for emoji resolution)
 * @param {boolean} showCompStats Show WR + last 5 match results when true
 * @param {boolean} isPartyLobby  True when rendering party lobby members
 * @param {string}  partyEmoji    Color indicator for players partied together (e.g. 🟥)
 */
const formatPlayerRow = async (player, channel, showCompStats = false, isPartyLobby = false, partyEmoji = "") => {
    // Strip tagline from riotId: "Name#TAG" -> "Name"
    const displayName = (player.riotId || "Unknown").split('#')[0];

    // Agent emoji — resolved dynamically from valorant-api.com icon URL.
    const localizedAgentName = player.agentName ? player.agentName["en-US"] || "Unknown" : null;

    let agentEmojiStr = "";
    if (localizedAgentName && player.agentIcon) {
        agentEmojiStr = emojiToString(await agentEmoji(localizedAgentName, player.agentIcon)) ?? (player.incognito ? "" : `\`${localizedAgentName}\``);
    } else if (player.incognito) {
        agentEmojiStr = "";
    } else if (localizedAgentName) {
        agentEmojiStr = `\`${localizedAgentName}\``;
    }

    // Current rank emoji — tier 0 (Unranked) now has an icon too
    const currentRankEmojiStr = player.currentTierIcon
        ? (emojiToString(await rankEmoji(player.currentTier, player.currentTierIcon)) ?? "")
        : "";

    // Place badge before RR for clean visual scanning: <rank_badge>**42**rr
    const rankPart = player.currentTier > 0
        ? (player.isRankFallback
            ? `${currentRankEmojiStr}`.trim()
            : `${currentRankEmojiStr}**${player.currentRR}**rr`.trim())
        : (currentRankEmojiStr ? `${currentRankEmojiStr}\`Unranked\`` : "`Unranked`");

    // Peak rank — badge before act label: <peak_badge>`E5A3`
    const peakRankEmojiStr = player.peakTier > 0 && player.peakTierIcon
        ? (emojiToString(await rankEmoji(player.peakTier, player.peakTierIcon)) ?? `\`${player.peakTierName}\``)
        : null;
    const peakPart = peakRankEmojiStr
        ? `${peakRankEmojiStr}\`${player.peakActLabel ?? "—"}\``
        : null;

    // Competitive-only: win-rate and last 5 match results
    let recentMatchesStr = "";
    const compParts = [];
    if (showCompStats) {
        if (player.winRate !== null)
            compParts.push(`**${player.winRate}%**wr \`${player.games}\``);

        if (player.recentMatches && player.recentMatches.length > 0) {
            const symbols = player.recentMatches.map(m => {
                if (m === "win") return "🔹";
                if (m === "loss") return "🔻";
                return "▫️";
            }).join("");
            recentMatchesStr = `・\`${symbols}\``;
        }
    }

    const rowTails = [rankPart, peakPart, ...compParts].filter(Boolean).join("・");
    const leaderBadge = (isPartyLobby && player.isLeader) ? "👑 " : "";
    const agentPrefix = agentEmojiStr ? `${agentEmojiStr} ` : "";
    const partyPrefix = (!isPartyLobby && partyEmoji) ? `${partyEmoji} ` : "";

    return `${partyPrefix}${agentPrefix}${leaderBadge}\`${displayName}\`・${rowTails}${recentMatchesStr}`;
};

/**
 * Build embed fields for a list of players, grouped 5 per field.
 * @param {string} [headerName] Optional name for the first field (defaults to zero-width space).
 */
const buildPlayerFields = async (players, channel, showCompStats, headerName = "\u200b", isPartyLobby = false, partyColorMap = null) => {
    const colorMap = partyColorMap ?? getPartyColorMap(players);
    const rows = await Promise.all(players.map(p =>
        formatPlayerRow(p, channel, showCompStats, isPartyLobby, p.partyId ? colorMap.get(p.partyId) : "")
    ));
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
 * • Two-team modes  → ally players in description, enemy players in fields with divider header.
 * • Single-team modes (deathmatch, …) → all players listed in `description`.
 */
const buildGameEmbed = async (data, allyPlayers, enemyPlayers, channel, userId = null) => {
    const stateLabel = STATE_LABEL[data.state] ?? "Live Game";
    const isPreGame = data.state === "pregame";
    const showCompStats = data.queueId === "competitive" || data.queueId === "skirmish" || data.queueId === "skirmish 2v2";
    const color = isPreGame ? COLOR_PREGAME : COLOR_ALLY;

    const formattedServer = formatServerName(data.serverName);
    const mapAndServer = formattedServer
        ? `${data.mapName}・${formattedServer}`
        : data.mapName;

    const embed = {
        author: {
            name: `${data.queueName}・${mapAndServer}`,
            icon_url: data.queueIcon ?? undefined,
        },
        color,
        image: data.mapImage ? { url: data.mapImage } : undefined,
        footer: { text: stateLabel },
        timestamp: new Date().toISOString(),
    };

    // Global party color map across both teams ensures distinct color indicators (e.g. two 5-stacks get 🟥 and 🟧)
    const allPlayers = [...allyPlayers, ...enemyPlayers];
    const partyColorMap = getPartyColorMap(allPlayers);

    if (data.isSingleTeam) {
        // Free-for-all: description block, one player per line
        const lines = await Promise.all(
            allPlayers.map(p => formatPlayerRow(p, channel, showCompStats, false, p.partyId ? partyColorMap.get(p.partyId) : ""))
        );
        embed.description = lines.join("\n");
    } else {
        // Two-team layout: ally players in description, enemy players in fields
        const [allyLines, enemyFields] = await Promise.all([
            Promise.all(allyPlayers.map(p => formatPlayerRow(p, channel, showCompStats, false, p.partyId ? partyColorMap.get(p.partyId) : ""))),
            enemyPlayers.length > 0
                ? buildPlayerFields(enemyPlayers, channel, showCompStats, "\u200b", false, partyColorMap)
                : Promise.resolve([]),
        ]);
        embed.description = allyLines.join("\n");
        if (enemyFields.length > 0) embed.fields = enemyFields;
    }

    return embed;
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

        let description = statusText;
        let subtext = `\n\n-# 🌐 **Servers:** ${serverFormatted}`;
        if (liveGameData.inviteCode) {
            subtext += `\n-# 🔑 **${s(userId).livegame?.PARTY_CODE || "Party Code"}** \`${liveGameData.inviteCode}\``;
        }
        description += subtext;

        const embed = {
            author,
            title,
            description,
            color,
            fields: hasParty ? await buildPlayerFields(allyPlayers, channel, true, (s(userId).livegame?.PARTY_MEMBERS || "Party Members"), true) : undefined,
        };

        let components = [liveGameRefreshRow(userId, liveGameData.inviteCode, true)];

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

                const codeButton = new ButtonBuilder()
                    .setCustomId(`livegame/make_code/${liveGameData.matchId}`)
                    .setLabel(s(userId).livegame.GENERATE_PARTY_CODE)
                    .setStyle(ButtonStyle.Secondary);
                buttonRow.addComponents(codeButton);

                if (liveGameData.inviteCode) {
                    const removeCodeButton = new ButtonBuilder()
                        .setCustomId(`livegame/remove_code/${liveGameData.matchId}`)
                        .setLabel(s(userId).livegame.REMOVE_PARTY_CODE)
                        .setStyle(ButtonStyle.Danger);
                    buttonRow.addComponents(removeCodeButton);
                }

                components.unshift(buttonRow);

                if (state === "not_in_game" && liveGameData.eligibleQueues && liveGameData.eligibleQueues.length > 0) {
                    let allQueues = [...liveGameData.eligibleQueues];
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
                                .addOptions(queueOptions)
                        );
                        components.unshift(queueSelectRow);
                    }
                }
            }
        }

        return { embeds: [embed], components };
    }

    const embed = await buildGameEmbed(liveGameData, allyPlayers, enemyPlayers, channel, userId);

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

            menuRows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`livegame/select_role/${liveGameData.matchId}`)
                    .setPlaceholder(s(userId).livegame.SELECT_AGENT_PLACEHOLDER || "Select a Role")
                    .addOptions(roleOptions)
            ));

            // 3. Conditionally build the Agent dropdown if a Role is selected
            if (selectedRole && roleNames.includes(selectedRole)) {
                const agentOptions = options.filter(o => o.role === selectedRole);
                if (agentOptions.length > 0) {
                    menuRows.push(new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`livegame/select_agent/${liveGameData.matchId}/0`)
                            .setPlaceholder(`Select an Agent (${uniqueRoles.get(selectedRole).roleLocalized})`)
                            .addOptions(agentOptions)
                    ));
                }
            }

            if (menuRows.length > 0) {
                components = [...menuRows, components[0]];
            }
        }
    }

    return {
        embeds: [embed],
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
