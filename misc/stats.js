import config from "./config.js";
import fs from "fs";
import { writeFileAtomic } from "./util.js";

let stats = {
    fileVersion: 2,
    stats: {}
};
let overallStats = {
    shopsIncluded: 0,
    items: {}
};
let statsLoaded = false;
let statsDirty = false;
let saveDebounceTimer = null;
const SAVE_DEBOUNCE_MS = 5000;

let statsClient = null;
export const setStatsClient = (client) => {
    statsClient = client;
};

/** "17-3-2026" → a UTC timestamp. Matches formatDate() below. */
const parseDayKey = (key) => {
    const [d, m, y] = String(key).split("-").map(Number);
    if (!d || !m || !y) return NaN;
    return Date.UTC(y, m - 1, d);
};

/**
 * Drop day buckets older than config.statsExpirationDays.
 *
 * This never existed. The config key was only ever read to fill in the
 * "no stats for this skin in the last N days" message shown to users, so the
 * number in that message was fiction and stats.json grew without bound —
 * every day retaining a Set of every puuid that opened their shop, all of it
 * loaded into memory on boot.
 *
 * @returns {boolean} true if anything was removed
 */
const pruneOldStats = () => {
    const days = config.statsExpirationDays;
    if (!days || days <= 0) return false;   // unset / 0 means keep everything

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const day of Object.keys(stats.stats)) {
        const ts = parseDayKey(day);
        if (Number.isNaN(ts) || ts >= cutoff) continue;
        delete stats.stats[day];
        removed++;
    }
    if (removed) console.log(`Pruned ${removed} day(s) of store stats older than ${days} days`);
    return removed > 0;
};

export const loadStats = (filename = "data/stats.json") => {
    if (!config.trackStoreStats) return;
    if (statsLoaded) return;
    try {
        if (fs.existsSync(filename)) {
            const obj = JSON.parse(fs.readFileSync(filename, "utf8"));
            if (obj.stats) {
                stats = obj;
                for (const day in stats.stats) {
                    if (Array.isArray(stats.stats[day].users)) {
                        stats.stats[day].users = new Set(stats.stats[day].users);
                    }
                }
            }
            statsLoaded = true;   // pruning writes, and saveStats must not re-enter this
            if (pruneOldStats()) debouncedSaveStats();
            calculateOverallStats();
        }
    } catch (e) {
        console.error("Failed to load store stats from disk:", e);
    }
    statsLoaded = true;
};

const saveStats = (filename = "data/stats.json") => {
    try {
        const serializableStats = {
            fileVersion: stats.fileVersion,
            stats: {}
        };
        for (const day in stats.stats) {
            const dayStats = stats.stats[day];
            serializableStats.stats[day] = {
                shopsIncluded: dayStats.shopsIncluded,
                items: dayStats.items,
                users: dayStats.users instanceof Set ? [...dayStats.users] : (dayStats.users || [])
            };
        }
        writeFileAtomic(filename, JSON.stringify(serializableStats));
        statsDirty = false;
    } catch (e) {
        console.error("Failed to save store stats to disk:", e);
    }
};

const debouncedSaveStats = () => {
    const shardId = statsClient?.shard?.ids?.[0];
    if (shardId !== undefined && shardId !== 0) return; // shard 0 only
    statsDirty = true;
    if (saveDebounceTimer) return;
    saveDebounceTimer = setTimeout(() => {
        saveDebounceTimer = null;
        if (statsDirty) saveStats();
    }, SAVE_DEBOUNCE_MS);
};

export const flushStats = () => {
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
    }
    if (statsDirty) saveStats();
};

export const calculateOverallStats = () => {
    overallStats.shopsIncluded = 0;
    overallStats.items = {};

    let items = {};
    for (const day in stats.stats) {
        const dayStats = stats.stats[day];
        overallStats.shopsIncluded += dayStats.shopsIncluded || 0;
        for (const item in dayStats.items) {
            items[item] = (items[item] || 0) + dayStats.items[item];
        }
    }

    const sortedItems = Object.entries(items).sort(([, a], [, b]) => b - a);
    for (const [uuid, count] of sortedItems) {
        overallStats.items[uuid] = count;
    }
};

export const getStatsFor = (uuid) => {
    loadStats();
    const entries = Object.entries(overallStats.items);
    const count = overallStats.items[uuid] || 0;

    // Rank by comparing counts, not by key insertion order. calculateOverallStats
    // inserts sorted, but addStore increments in place without re-sorting, so
    // the order drifted further from the truth with every shop opened after boot.
    const rank = count > 0 ? entries.filter(([, c]) => c > count).length + 1 : 0;

    return {
        shopsIncluded: overallStats.shopsIncluded || 0,
        count: count,
        amount: count,
        percentage: Math.round((count / (overallStats.shopsIncluded || 1)) * 1000) / 10,
        rank: [rank, entries.length]
    };
};

export const getOverallStats = () => {
    loadStats();
    return overallStats;
};

export const addStore = async (puuid, items) => {
    if (!config.trackStoreStats) return;

    const today = formatDate(new Date());

    loadStats();
    let todayStats = stats.stats[today];
    if (!todayStats) {
        // Rolling over to a new day is the natural once-a-day moment to prune.
        if (pruneOldStats()) calculateOverallStats();
        todayStats = { shopsIncluded: 0, items: {}, users: new Set() };
        stats.stats[today] = todayStats;
    } else if (Array.isArray(todayStats.users)) {
        todayStats.users = new Set(todayStats.users);
    }

    if (todayStats.users.has(puuid)) return;
    todayStats.users.add(puuid);

    for (const item of items) {
        todayStats.items[item] = (todayStats.items[item] || 0) + 1;
        overallStats.items[item] = (overallStats.items[item] || 0) + 1;
    }
    todayStats.shopsIncluded++;
    overallStats.shopsIncluded++;

    debouncedSaveStats();
};

const formatDate = (date) => `${date.getUTCDate()}-${date.getUTCMonth() + 1}-${date.getUTCFullYear()}`;
