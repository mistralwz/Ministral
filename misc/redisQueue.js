import Redis from "ioredis";
import config from "./config.js";
import { localLog, localError } from "./logger.js";

let redis = null;
let subscriber = null;
let isConnected = false;

// Initialize Redis connections
export const initRedis = async () => {
    try {
        // Main Redis client for data caching & queues
        redis = new Redis({
            host: config.redisHost,
            port: config.redisPort,
            password: config.redisPassword,
            db: config.redisDb,
            retryStrategy: (times) => times > 3 ? null : Math.min(times * 100, 1000),
            maxRetriesPerRequest: 1,
            enableReadyCheck: true,
            lazyConnect: true
        });

        // Separate client for pub/sub (Redis requirement)
        subscriber = new Redis({
            host: config.redisHost,
            port: config.redisPort,
            password: config.redisPassword,
            db: config.redisDb,
            retryStrategy: (times) => times > 3 ? null : Math.min(times * 100, 1000),
            maxRetriesPerRequest: 1,
            lazyConnect: true
        });

        redis.on('error', (err) => {
            localError('Redis client error:', err);
            isConnected = false;
        });

        redis.on('connect', () => {
            localLog('Redis connected');
            isConnected = true;
        });

        subscriber.on('error', (err) => {
            localError('Redis subscriber error:', err);
        });

        await redis.connect();
        await subscriber.connect();

        localLog("Redis queue initialized successfully");
        return true;
    } catch (e) {
        localError("Failed to initialize Redis:", e);
        redis = null;
        subscriber = null;
        isConnected = false;
        return false;
    }
};

// Check if Redis is available
export const isRedisAvailable = () => isConnected && redis !== null;

// ==================== PUB/SUB FOR LOGS ====================

const LOGS_CHANNEL = "skinpeek:logs";

// Publish logs to all shards
export const publishLogMessages = async (messages) => {
    if (!isRedisAvailable()) return;
    try {
        await redis.publish(LOGS_CHANNEL, JSON.stringify(messages));
    } catch (e) {
        localError("Failed to publish log messages:", e);
    }
};

// Subscribe to logs
export const subscribeToLogMessages = async (callback) => {
    if (!subscriber) return;

    await subscriber.subscribe(LOGS_CHANNEL);
    subscriber.on('message', (channel, message) => {
        if (channel === LOGS_CHANNEL) {
            try {
                const data = JSON.parse(message);
                callback(data);
            } catch (e) {
                localError("Failed to parse log messages:", e);
            }
        }
    });
};

// ==================== INVENTORY DATA CACHE ====================

const INVENTORY_CACHE_PREFIX = "skinpeek:inventory:";
const INVENTORY_CACHE_EXPIRY = 60 * 10; // 10 minutes

// Store inventory in Redis
export const setInventoryData = async (userId, target, data) => {
    if (!isRedisAvailable()) return;
    try {
        const key = `${INVENTORY_CACHE_PREFIX}${userId}:${target}`;
        await redis.setex(key, INVENTORY_CACHE_EXPIRY, JSON.stringify(data));
    } catch (e) {
        localError("Failed to set inventory cache:", e);
    }
};

// Get inventory from Redis
export const getInventoryData = async (userId, target) => {
    if (!isRedisAvailable()) return null;

    try {
        const key = `${INVENTORY_CACHE_PREFIX}${userId}:${target}`;
        const data = await redis.get(key);
        if (!data) return null;
        return JSON.parse(data);
    } catch (e) {
        localError("Failed to get/parse inventory cache:", e);
        return null;
    }
};

// ==================== RATE LIMIT STATE (SHARED) ====================

const RATE_LIMIT_PREFIX = "skinpeek:ratelimit:";

// Store rate limit for a URL
export const setRateLimit = async (url, retryAt) => {
    if (!isRedisAvailable()) return;

    try {
        const key = `${RATE_LIMIT_PREFIX}${url}`;
        const ttl = Math.ceil((retryAt - Date.now()) / 1000);
        if (ttl > 0) {
            await redis.setex(key, ttl, retryAt.toString());
        }
    } catch (e) {
        localError("Failed to set rate limit in Redis:", e);
    }
};

// Get rate limit for a URL
export const getRateLimit = async (url) => {
    if (!isRedisAvailable()) return null;

    try {
        const key = `${RATE_LIMIT_PREFIX}${url}`;
        const data = await redis.get(key);
        return data ? parseInt(data, 10) : null;
    } catch (e) {
        localError("Failed to get rate limit from Redis:", e);
        return null;
    }
};

// ==================== STATS OPERATIONS ====================

const STATS_PREFIX = "skinpeek:stats:";
const STATS_TTL = 72 * 3600; // 3 days

/**
 * Atomically record a shop visit for stats tracking.
 * Returns true if newly counted, false if already counted today, null if Redis unavailable.
 */
export const statsAddStore = async (puuid, items, date) => {
    if (!isRedisAvailable()) return null;

    try {
        const usersKey = `${STATS_PREFIX}${date}:users`;
        const isNew = await redis.sadd(usersKey, puuid);
        if (!isNew) return false; // already counted today

        const pipeline = redis.pipeline();
        pipeline.incr(`${STATS_PREFIX}${date}:shops`);
        for (const item of items) {
            pipeline.hincrby(`${STATS_PREFIX}${date}:items`, item, 1);
        }
        pipeline.expire(usersKey, STATS_TTL);
        pipeline.expire(`${STATS_PREFIX}${date}:shops`, STATS_TTL);
        pipeline.expire(`${STATS_PREFIX}${date}:items`, STATS_TTL);
        await pipeline.exec();
        return true;
    } catch (e) {
        localError("Failed to record store stats in Redis:", e);
        return null;
    }
};

// ==================== SHOP DATA CACHE ====================

const SHOPDATA_PREFIX = "skinpeek:shopdata:";
const SHOPDATA_TTL = 25 * 3600; // 25 hours (slightly more than daily shop reset)

export const setShopData = async (puuid, shopCache) => {
    if (!isRedisAvailable()) return;
    try {
        await redis.setex(`${SHOPDATA_PREFIX}${puuid}`, SHOPDATA_TTL, JSON.stringify(shopCache));
    } catch (e) {
        localError("Failed to set shop data in Redis:", e);
    }
};

export const getShopData = async (puuid) => {
    if (!isRedisAvailable()) return null;
    try {
        const data = await redis.get(`${SHOPDATA_PREFIX}${puuid}`);
        if (!data) return null;
        return JSON.parse(data);
    } catch (e) {
        localError("Failed to get/parse shop data from Redis:", e);
        return null;
    }
};

export const deleteShopData = async (puuid) => {
    if (!isRedisAvailable()) return;
    try {
        await redis.del(`${SHOPDATA_PREFIX}${puuid}`);
    } catch (e) {
        localError("Failed to delete shop data from Redis:", e);
    }
};

export const clearAllShopData = async (batchSize = 200) => {
    if (!isRedisAvailable()) return 0;

    let cursor = "0";
    let deletedCount = 0;

    try {
        do {
            const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${SHOPDATA_PREFIX}*`, "COUNT", batchSize);
            cursor = nextCursor;

            if (keys.length > 0) {
                deletedCount += await redis.del(...keys);
            }
        } while (cursor !== "0");
    } catch (e) {
        localError("Failed to clear all shop data keys:", e);
        throw e;
    }

    return deletedCount;
};
