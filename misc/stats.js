import config from "./config.js";
import fs from "fs";
import { statsAddStore } from "./redisQueue.js";

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

export const loadStats = (filename = "data/stats.json") => {
    if (!config.trackStoreStats) return;
    if (statsLoaded) return;
    try {
        if (fs.existsSync(filename)) {
            const obj = JSON.parse(fs.readFileSync(filename, "utf8"));
            if (!obj.fileVersion) transferStatsFromV1(obj);
            else stats = obj;
            calculateOverallStats();
        }
    } catch (e) {
        console.error("Failed to load store stats from disk:", e);
    }
    statsLoaded = true;
};

const saveStats = (filename = "data/stats.json") => {
    try {
        const dir = filename.substring(0, filename.lastIndexOf("/"));
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filename, JSON.stringify(stats, null, 2));
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

    for (const day in stats.stats) {
        const dayStats = stats.stats[day];
        overallStats.shopsIncluded += dayStats.shopsIncluded;
        for (const item in dayStats.items) {
            overallStats.items[item] = (overallStats.items[item] || 0) + dayStats.items[item];
        }
    }
};

export const getStatsFor = (item) => {
    loadStats();
    let statsForItem = {
        amount: 0,
        percentage: 0
    };

    if (item in overallStats.items) {
        statsForItem.amount = overallStats.items[item];
        statsForItem.percentage = Math.round((overallStats.items[item] / overallStats.shopsIncluded) * 1000) / 10;
    }

    return statsForItem;
};

export const getOverallStats = () => {
    loadStats();
    return overallStats;
};

export const addStore = async (puuid, items) => {
    if (!config.trackStoreStats) return;

    const today = formatDate(new Date());

    try {
        const isNew = await statsAddStore(puuid, items, today);
        if (isNew === false) return; // already counted in redis

        if (isNew === true) {
            loadStats();
            let todayStats = stats.stats[today];
            if (!todayStats) {
                todayStats = { shopsIncluded: 0, items: {}, users: [] };
                stats.stats[today] = todayStats;
            }
            if (!todayStats.users.includes(puuid)) {
                todayStats.users.push(puuid);
                for (const item of items) {
                    todayStats.items[item] = (todayStats.items[item] || 0) + 1;
                }
                todayStats.shopsIncluded++;
            }
            debouncedSaveStats();
            calculateOverallStats();
            return;
        }
    } catch (e) {
        console.error("Redis stats error, falling back to local memory stats:", e);
    }

    // Local in-memory stats fallback
    loadStats();
    let todayStats = stats.stats[today];
    if (!todayStats) {
        todayStats = { shopsIncluded: 0, items: {}, users: [] };
        stats.stats[today] = todayStats;
    }

    if (todayStats.users.includes(puuid)) return;
    todayStats.users.push(puuid);

    for (const item of items) {
        todayStats.items[item] = (todayStats.items[item] || 0) + 1;
    }
    todayStats.shopsIncluded++;

    debouncedSaveStats();
    calculateOverallStats();
};

const formatDate = (date) => `${date.getUTCDate()}-${date.getUTCMonth() + 1}-${date.getUTCFullYear()}`;

const transferStatsFromV1 = (obj) => {
    stats.stats[formatDate(new Date())] = {
        shopsIncluded: obj.shopsIncluded || 0,
        items: obj.itemStats || {},
        users: obj.usersAddedToday || []
    };
};
