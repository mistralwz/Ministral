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

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import { s, discToValLang, DEFAULT_VALORANT_LANG } from "../misc/languages.js";
import { getSetting } from "../misc/settings.js";
import config from "../misc/config.js";
import { resolveAgent, getOwnedAgents, resolveQueueName, resolveQueueIcon, resolveServerName } from "../valorant/livegame.js";
import { getUser } from "../valorant/auth.js";
import { agentEmoji, rankEmoji, queueEmoji } from "./emoji.js";
import { emojiToString } from "../misc/util.js";

const roleSelections = new Map();
export const setRoleSelection = (userId, role) => roleSelections.set(userId, role);

// ─── Colours ────────────────────────────────────────────────────────────────
const COLOR_PREGAME = 0xFFB300;  // amber  — agent select
const COLOR_ALLY = 0x1E88E5;  // blue   — in-game

// ─── State labels ────────────────────────────────────────────────────────────
const STATE_LABEL = {
    pregame: "🟡 Agent Select",
    ingame: "🔴 In-Game",
    not_in_game: "⬜ Not in a match",
    queuing: "🕒 Queuing",
};

// ─── Player row renderer ─────────────────────────────────────────────────────

/**
 * Render one player as a single compact line, placed in the field VALUE.
 *
 * Format (all modes):
 *   <agent>  `RiotId`・<rank> **42 RR**・<peak> (E5A3)
 *
 * Competitive also appends:
 *   ・**46%WR** (13)┊`🔹13:5`
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
    const localizedAgentName = player.agentName ? player.agentName["en-US"] || "Unknown" : null;

    const agentEmojiStr = localizedAgentName && player.agentIcon
        ? (emojiToString(await agentEmoji(localizedAgentName, player.agentIcon)) ?? (player.incognito ? "" : `\`${localizedAgentName}\``))
        : (player.incognito ? "" : (localizedAgentName ? `\`${localizedAgentName}\`` : ""));

    // Current rank emoji — tier 0 (Unranked) now has an icon too
    const currentRankEmojiStr = player.currentTierIcon
        ? (emojiToString(await rankEmoji(player.currentTier, player.currentTierIcon)) ?? "")
        : "";

    const rankPart = player.currentTier > 0
        ? `**${player.currentRR}**rr ${currentRankEmojiStr}`.trim()
        : currentRankEmojiStr || "`Unranked`";

    // Peak rank — shown in all modes; text fallback when emoji is unavailable
    const peakRankEmojiStr = player.peakTier > 0 && player.peakTierIcon
        ? (emojiToString(await rankEmoji(player.peakTier, player.peakTierIcon)) ?? `\`${player.peakTierName}\``)
        : null;
    const peakPart = peakRankEmojiStr
        ? `\`${player.peakActLabel ?? "—"}\` ${peakRankEmojiStr}`
        : null;

    // Competitive-only: win-rate and last match score
    let matchScoreStr = "";
    const compParts = [];
    if (showCompStats) {
        if (player.winRate !== null)
            compParts.push(`**${player.winRate}%**wr \`${player.games}\``);

        const lastMatch = player.recentMatches?.[0];
        if (lastMatch) {
            let symbol = lastMatch.allyScore === lastMatch.enemyScore
                ? "▫️"
                : (lastMatch.win ? "🔹" : "🔻");
            matchScoreStr = `┊\`${symbol}${lastMatch.allyScore}:${lastMatch.enemyScore}\``;
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
            name: `${data.queueName}・${mapAndServer}`,
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

    let discLang = config.localiseText ? getSetting(userId, 'locale') : 'en-GB';
    if (discLang === "Automatic") discLang = 'en-US';
    const valLang = discToValLang[discLang] || DEFAULT_VALORANT_LANG;

    if (state === "not_in_game" || state === "queuing") {
        roleSelections.delete(userId);
        const hasParty = allyPlayers && allyPlayers.length > 0;

        let title, description, color;
        const qUpper = liveGameData.queueId?.toUpperCase() || "CUSTOM";
        const dictQ = (s(userId).queues && qUpper in s(userId).queues) ? s(userId).queues[qUpper] : undefined;
        const localizedQueueNameQueueing = dictQ || resolveQueueName(liveGameData.queueId, valLang);

        if (state === "queuing") {
            title = s(userId).livegame.QUEUING_TITLE;
            description = s(userId).livegame.QUEUING_DESC.f({ queueName: localizedQueueNameQueueing });
            color = COLOR_PREGAME;
        } else {
            title = hasParty ? (s(userId).livegame.IDLE_PARTY_TITLE || "Idle in Party") : s(userId).livegame.NOT_IN_MATCH_TITLE;
            description = hasParty ? (s(userId).livegame.IDLE_PARTY_DESC || "Waiting to queue.") : s(userId).livegame.NOT_IN_MATCH_DESC;
            color = 0x616161;
        }

        const serverText = (liveGameData.preferredGamePods && liveGameData.preferredGamePods.length > 0)
            ? s(userId).livegame.PREFERRED_SERVERS.f({ servers: liveGameData.preferredGamePods.map(resolveServerName).join(", ") })
            : s(userId).livegame.AUTO_SERVERS;

        const embed = {
            title,
            description: liveGameData.inviteCode
                ? `${description}\n\n${s(userId).livegame.PARTY_CODE} **${liveGameData.inviteCode}**`
                : description,
            color,
            fields: hasParty ? await buildPlayerFields(allyPlayers, channel, true, (s(userId).livegame.PARTY_MEMBERS || "Party Members")) : undefined,
            footer: { text: serverText },
        };

        let components = [liveGameRefreshRow(userId)];

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
                let lockButtonRow;
                if (myPlayer.agentId) {
                    lockButtonRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`livegame/lock_agent/${liveGameData.matchId}/${myPlayer.agentId.toLowerCase()}`)
                            .setLabel("Lock In")
                            .setStyle(ButtonStyle.Success)
                    );
                }

                components = lockButtonRow
                    ? [...menuRows, lockButtonRow, components[0]]
                    : [...menuRows, components[0]];
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
