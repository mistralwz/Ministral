import config from "./config.js";
import fs from "fs";
import {client} from "../discord/bot.js";

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
const SAVE_DEBOUNCE_MS = 5000; // batch saves within 5 seconds

export const loadStats = (filename="data/stats.json") => {
    if(!config.trackStoreStats) return;
    if(statsLoaded) return; // already loaded, no need to re-read from disk
    try {
        const obj = JSON.parse(fs.readFileSync(filename).toString());

        if(!obj.fileVersion) transferStatsFromV1(obj);
        else stats = obj;

        calculateOverallStats();
    } catch(e) {}
    statsLoaded = true;
}

const saveStats = (filename="data/stats.json") => {
    const dir = filename.substring(0, filename.lastIndexOf("/"));
    if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filename, JSON.stringify(stats, null, 2));
    statsDirty = false;
}

const debouncedSaveStats = () => {
    if(client.shard && client.shard.ids[0] !== 0) return; // shard 0 only
    statsDirty = true;
    if(saveDebounceTimer) return; // already scheduled
    saveDebounceTimer = setTimeout(() => {
        saveDebounceTimer = null;
        if(statsDirty) saveStats();
    }, SAVE_DEBOUNCE_MS);
}

// Ensure stats are flushed to disk (call on shutdown or forced save)
export const flushStats = () => {
    if(saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
    }
    if(statsDirty) saveStats();
}

export const calculateOverallStats = () => {
    overallStats = {
        shopsIncluded: 0,
        items: {}
    }
    let items = {};
    let needsCleanup = false;

    for(let dateString in stats.stats) {
        if(config.statsExpirationDays && daysAgo(dateString) > config.statsExpirationDays) {
            needsCleanup = true;
            continue;
        }
        const dayStats = stats.stats[dateString];

        overallStats.shopsIncluded += dayStats.shopsIncluded;
        for(let item in dayStats.items) {
            if(item in items) {
                items[item] += dayStats.items[item];
            } else {
                items[item] = dayStats.items[item];
            }
        }
    }

    // Clean up expired entries lazily
    if(needsCleanup) {
        cleanupStats();
    }

    const sortedItems = Object.entries(items).sort(([,a], [,b]) => b - a);
    for(const [uuid, count] of sortedItems) {
        overallStats.items[uuid] = count;
    }
}

export const getOverallStats = () => {
    loadStats();
    return overallStats || {};
}

export const getStatsFor = (uuid) => {
    loadStats();
    return {
        shopsIncluded: overallStats.shopsIncluded,
        count: overallStats.items[uuid] || 0,
        rank: [Object.keys(overallStats.items).indexOf(uuid) + 1, Object.keys(overallStats.items).length]
    }
}

export const addStore = async (puuid, items) => {
    if(!config.trackStoreStats) return;

    const today = formatDate(new Date());

    // Try Redis first: atomic cross-shard dedup via SADD
    const {statsAddStore, isRedisAvailable} = await import("./redisQueue.js");
    if(isRedisAvailable()) {
        const isNew = await statsAddStore(puuid, items, today);
        if(isNew === false) return; // already counted today (cross-shard dedup)
        if(isNew === true) {
            // Update in-memory state for same-shard reads
            loadStats();
            let todayStats = stats.stats[today];
            if(!todayStats) {
                todayStats = { shopsIncluded: 0, items: {}, users: [] };
                stats.stats[today] = todayStats;
            }
            if(!todayStats.users.includes(puuid)) {
                todayStats.users.push(puuid);
                for(const item of items) {
                    todayStats.items[item] = (todayStats.items[item] || 0) + 1;
                }
                todayStats.shopsIncluded++;
            }
            debouncedSaveStats(); // no-op on non-zero shards
            calculateOverallStats();
            return;
        }
        // isNew === null: Redis unavailable, fall through to disk-based approach
    }

    // Fallback: disk-based approach (Redis unavailable)
    loadStats();

    let todayStats = stats.stats[today];
    if(!todayStats) {
        todayStats = {
            shopsIncluded: 0,
            items: {},
            users: []
        };
        stats.stats[today] = todayStats;
    }

    if(todayStats.users.includes(puuid)) return;
    todayStats.users.push(puuid);

    for(const item of items) {
        if(item in todayStats.items) {
            todayStats.items[item]++;
        } else {
            todayStats.items[item] = 1;
        }
    }
    todayStats.shopsIncluded++;

    debouncedSaveStats();

    calculateOverallStats();
}

const cleanupStats = () => {
    if(!config.statsExpirationDays) return;

    for(const dateString in stats.stats) {
        if(daysAgo(dateString) > config.statsExpirationDays) {
            delete stats.stats[dateString];
        }
    }

    debouncedSaveStats();
}

const formatDate = (date) => {
    return `${date.getUTCDate()}-${date.getUTCMonth() + 1}-${date.getUTCFullYear()}`;
}

const daysAgo = (dateString) => {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);

    const [day, month, year] = dateString.split("-");
    const date = new Date(Date.UTC(year, month - 1, day));

    return Math.floor((now - date) / (1000 * 60 * 60 * 24));
}

const transferStatsFromV1 = (obj) => {
    stats.stats[formatDate(new Date())] = {
        shopsIncluded: obj.shopsIncluded,
        items: obj.itemStats,
        users: obj.usersAddedToday
    };
}
