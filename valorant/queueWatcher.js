import { getPartyData, probeLiveGameState, resolveQueueName } from "./livegame.js";
import { getUserList, getUser } from "./auth.js";
import { s } from "../misc/languages.js";
import { getSetting } from "../misc/settings.js";
import { EmbedBuilder } from "discord.js";

// Watches a queue the user started from the /livegame embed, and stays quiet
// until the match actually exists. The party is only useful for the early
// "did they cancel?" answer - once a match is found it's the pregame/core-game
// probe that tells us, because the party is torn apart the moment it starts.

const watchers = new Map();

const TICK_INTERVAL = 3000;
const WATCH_TIMEOUT = 45 * 60 * 1000;
const KEEP_WATCHING_AFTER_FOUND = 3 * 60 * 1000;
const AFK_REPING_DELAY = 60000;
const MISSED_TICK_LIMIT = 3;

export const isWatching = (userId) => watchers.has(userId);

export const cancelWatcher = (userId) => {
    const watcher = watchers.get(userId);
    if (!watcher) return;
    clearInterval(watcher.timer);
    clearTimeout(watcher.deadline);
    clearTimeout(watcher.afkTimer);
    clearTimeout(watcher.expiry);
    watchers.delete(userId);
};

export const stopAllWatchers = () => {
    for (const userId of [...watchers.keys()]) cancelWatcher(userId);
};

const fmtDuration = (ms) => {
    const secs = Math.floor(ms / 1000);
    const mins = Math.floor(secs / 60);
    return mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
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

const sendPing = async (state, payload) => {
    try {
        await state.interaction.followUp(payload);
    } catch (e) {
        console.error(`[queuewatch] failed to ping for ${state.userId}:`, e.message);
    }
};

const queueLabel = (state) => {
    if (!state.mode) return null;
    return resolveQueueName(state.mode, "en-US") || state.mode;
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
        foundAt: null,
        missedTicks: 0,
        members: [],
        timer: null,
        deadline: null,
        afkTimer: null,
        expiry: null
    };

    state.deadline = setTimeout(() => cancelWatcher(userId), WATCH_TIMEOUT);
    state.timer = setInterval(() => tick(state).catch(e => console.error(`[queuewatch] error for ${userId}:`, e.message)), TICK_INTERVAL);
    watchers.set(userId, state);

    // Grabbed once up front so the ping can mention the rest of the party
    // without another request at the moment the match is found.
    getPartyData(userId, null, partyId)
        .then(res => { if (res.success && res.members) state.members = res.members; })
        .catch(() => {});
};

const tick = async (state) => {
    if (!watchers.has(state.userId)) return;

    const probe = await probeLiveGameState(state.userId);
    if (!probe.success) return; // transient read error, the deadline is the backstop

    if (probe.state !== "not_in_game") {
        state.missedTicks = 0;
        await onMatchFound(state);
        return;
    }

    // Riot reports a short gap between one match ending and the next being
    // visible, and a single failed read looks identical, so wait for a few
    // consistent ones before believing the player is out of a match.
    state.missedTicks++;
    if (state.missedTicks < MISSED_TICK_LIMIT) return;

    if (state.foundNotified) {
        // Only worth reporting while dodging is still possible - a game that
        // simply finished shouldn't be announced as a dodge.
        if (Date.now() - state.foundAt < KEEP_WATCHING_AFTER_FOUND) onDodged(state);
        cancelWatcher(state.userId);
        return;
    }

    const party = await getPartyData(state.userId, null, state.partyId);
    if (party.success && party.state === "queuing") {
        state.missedTicks = 0;
        return;
    }

    cancelWatcher(state.userId); // queue cancelled or left, no match happened
};

const onMatchFound = async (state) => {
    if (state.foundNotified) return;
    state.foundNotified = true;
    state.foundAt = Date.now();

    let mentions = `<@${state.userId}>`;
    try {
        const discordIds = [state.userId, ...(await resolveDiscordUsersForPuuids(state.members.map(m => m.puuid)))];
        mentions = [...new Set(discordIds)].map(id => `<@${id}>`).join(" ");
    } catch {
        // worst case only the person who queued gets pinged
    }

    const strings = s(state.userId).livegame;
    const label = queueLabel(state);

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(label ? strings.MATCH_FOUND_TITLE.f({ q: label }) : strings.MATCH_FOUND_TITLE_GENERIC)
        .setDescription(strings.MATCH_FOUND_DESC.f({ t: fmtDuration(Date.now() - state.startedAt) }))
        .setTimestamp();

    await sendPing(state, { content: `${mentions} ${strings.MATCH_FOUND_PING}`, embeds: [embed] });

    if (getSetting(state.userId, "queueAfkReping")) {
        state.afkTimer = setTimeout(async () => {
            if (!watchers.has(state.userId)) return;

            // Only nag while they're still sat in agent select - if they
            // accepted, the probe has already moved on to the match itself.
            const check = await probeLiveGameState(state.userId).catch(() => null);
            if (check?.success && check.state !== "pregame") return;

            sendPing(state, { content: `${mentions} ${strings.MATCH_FOUND_AFK}` });
        }, AFK_REPING_DELAY);
    }

    // Keep the watcher alive through the accept + agent select window so a
    // dodge after the ping still leaves the user with an answer instead of
    // silence. Everything is torn down after that.
    state.expiry = setTimeout(() => cancelWatcher(state.userId), KEEP_WATCHING_AFTER_FOUND);
};

const onDodged = (state) => {
    const embed = new EmbedBuilder()
        .setColor(0xf5b942)
        .setDescription(s(state.userId).livegame.MATCH_DODGED);
    state.interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
};
