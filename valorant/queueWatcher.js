import { getPartyData } from "./livegame.js";
import { getUserList, getUser } from "./auth.js";
import { EmbedBuilder } from "discord.js";

const watchers = new Map();

export const isWatching = (userId) => watchers.has(userId);

export const cancelWatcher = (userId) => {
    const w = watchers.get(userId);
    if (!w) return;
    clearInterval(w.timer);
    clearTimeout(w.deadline);
    clearTimeout(w.afkTimer);
    watchers.delete(userId);
};

export const stopAllWatchers = () => {
    for (const userId of [...watchers.keys()]) cancelWatcher(userId);
};

const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
};

export const resolveDiscordUsersForPuuids = async (puuids) => {
    const known = new Set(puuids.map(p => p.toLowerCase()));
    const matches = [];
    for (const discordId of getUserList()) {
        try {
            const user = getUser(discordId);
            if (user && user.puuid && known.has(user.puuid.toLowerCase())) {
                matches.push(discordId);
            }
        } catch {}
    }
    return matches;
};

const sendPing = async (state, content) => {
    try {
        await state.interaction.followUp({ content });
    } catch (e) {
        console.error(`[queuewatch] failed to ping for ${state.userId}:`, e.message);
    }
};

export const startQueueWatcher = (userId, interaction, partyId, mode) => {
    cancelWatcher(userId);

    const state = {
        userId,
        interaction,
        partyId,
        mode: mode || null,
        startedAt: Date.now(),
        foundNotified: false,
        timer: null,
        deadline: null,
        afkTimer: null
    };

    state.deadline = setTimeout(() => {
        if (!watchers.has(userId)) return;
        cancelWatcher(userId);
    }, 45 * 60 * 1000);

    const tick = async () => {
        if (!watchers.has(userId)) return;
        try {
            const res = await getPartyData(userId, null, state.partyId);
            if (!res.success) {
                cancelWatcher(userId);
                return;
            }

            if (res.state === "queuing") return;

            const pregame = await probePregame(userId, res.matchId);
            if (pregame) {
                onMatchFound(state, res.members || []);
                return;
            }

            if (res.state === "not_queuing") {
                if (state.foundNotified) {
                    onDodged(state);
                }
                cancelWatcher(userId);
            }
        } catch (e) {
            console.error(`[queuewatch] error for ${userId}:`, e.message);
        }
    };

    state.timer = setInterval(tick, 3000);
    watchers.set(userId, state);
};

const probePregame = async (userId, knownMatchId) => {
    const { repollLiveGame, LIVEGAME_UNCHANGED } = await import("./livegame.js");
    const probe = await repollLiveGame(userId, null, "queuing", knownMatchId).catch(() => null);
    if (probe && probe !== LIVEGAME_UNCHANGED) return probe;
    return null;
};

const onMatchFound = async (state, members) => {
    if (state.foundNotified) return;
    state.foundNotified = true;
    clearInterval(state.timer);
    clearTimeout(state.deadline);

    const puuids = members.map(m => m.puuid);
    let mentions;
    try {
        const myUser = getUser(state.userId);
        const discordIds = [state.userId, ...(await resolveDiscordUsersForPuuids(puuids))];
        mentions = [...new Set(discordIds)].map(id => `<@${id}>`).join(" ");
    } catch {
        mentions = `<@${state.userId}>`;
    }

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(state.mode ? `Match found — ${state.mode}` : "Match found")
        .setDescription(`Get in! Queue time: \`${fmtDuration(Date.now() - state.startedAt)}\``)
        .setTimestamp();

    await sendPing(state, { content: `${mentions} 🎮`, embeds: [embed] });

    const { getSetting } = await import("../misc/settings.js");
    if (getSetting(state.userId, "queueAfkReping")) {
        state.afkTimer = setTimeout(() => {
            if (!watchers.has(state.userId)) return;
            sendPing(state, `${mentions} still waiting on your accept...`);
        }, 60000);
    }

    setTimeout(() => cancelWatcher(state.userId), 120000);
};

const onDodged = (state) => {
    const embed = new EmbedBuilder()
        .setColor(0xf5b942)
        .setDescription("Match was dodged or cancelled — you're back in the lobby.");
    state.interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
};
