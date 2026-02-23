import Redis from "ioredis";
import config from "./config.js";
import { localLog, localError } from "./logger.js";

let redis = null;
let subscriber = null;
let isConnected = false;

// Initialize Redis connections
export const initRedis = async () => {
    if (!config.useRedis) {
        localLog("Redis is disabled in config");
        return false;
    }

    try {
        // Main Redis client for queue operations
        redis = new Redis({
            host: config.redisHost,
            port: config.redisPort,
            password: config.redisPassword,
            db: config.redisDb,
            retryStrategy: (times) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: true
        });

        // Separate client for pub/sub (Redis requirement)
        subscriber = new Redis({
            host: config.redisHost,
            port: config.redisPort,
            password: config.redisPassword,
            db: config.redisDb,
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
export const isRedisAvailable = () => {
    return isConnected && redis !== null;
};

// Close Redis connections
export const closeRedis = async () => {
    if (redis) {
        await redis.quit();
        redis = null;
    }
    if (subscriber) {
        await subscriber.quit();
        subscriber = null;
    }
    isConnected = false;
};

// ==================== AUTH QUEUE OPERATIONS ====================

const AUTH_QUEUE_KEY = "skinpeek:auth:queue";
const AUTH_RESULT_PREFIX = "skinpeek:auth:result:";
const AUTH_PROCESSING_KEY = "skinpeek:auth:processing";
const AUTH_PROCESSING_LOCK = "skinpeek:auth:processing_lock";
const RESULT_EXPIRY = 300; // 5 minutes
const LOCK_TTL = 30; // seconds

// Push auth operation to queue
export const pushAuthQueue = async (operation) => {
    if (!isRedisAvailable()) throw new Error("Redis not available");

    const queueItem = {
        ...operation,
        timestamp: Date.now()
    };

    await redis.rpush(AUTH_QUEUE_KEY, JSON.stringify(queueItem));
    return queueItem;
};

// Pop auth operation from queue (atomic)
export const popAuthQueue = async () => {
    if (!isRedisAvailable()) return null;

    const item = await redis.lpop(AUTH_QUEUE_KEY);
    if (!item) return null;

    try {
        return JSON.parse(item);
    } catch (e) {
        localError("Failed to parse queue item:", e);
        return null;
    }
};

// Get queue length
export const getAuthQueueLength = async () => {
    if (!isRedisAvailable()) return 0;
    return await redis.llen(AUTH_QUEUE_KEY);
};

// Store auth result
export const storeAuthResult = async (c, result) => {
    if (!isRedisAvailable()) throw new Error("Redis not available");

    const key = `${AUTH_RESULT_PREFIX}${c}`;
    await redis.setex(key, RESULT_EXPIRY, JSON.stringify({
        result,
        timestamp: Date.now()
    }));
};

// Get auth result (atomic get-and-delete)
export const getAuthResult = async (c) => {
    if (!isRedisAvailable()) return null;

    const key = `${AUTH_RESULT_PREFIX}${c}`;
    const data = await redis.getdel(key); // Atomic operation (Redis 6.2+)
    
    if (!data) return null;

    try {
        const parsed = JSON.parse(data);
        return parsed.result;
    } catch (e) {
        localError("Failed to parse auth result:", e);
        return null;
    }
};

// Check if operation is being processed
export const isAuthProcessing = async (c) => {
    if (!isRedisAvailable()) return false;
    const processing = await redis.hget(AUTH_PROCESSING_KEY, c.toString());
    return processing !== null;
};

// Mark operation as processing
export const markAuthProcessing = async (c, shardId) => {
    if (!isRedisAvailable()) return;
    await redis.hset(AUTH_PROCESSING_KEY, c.toString(), JSON.stringify({
        shardId,
        timestamp: Date.now()
    }));
};

// Unmark operation as processing
export const unmarkAuthProcessing = async (c) => {
    if (!isRedisAvailable()) return;
    await redis.hdel(AUTH_PROCESSING_KEY, c.toString());
};

// Clean up stale processing marks (older than 5 minutes)
export const cleanupStaleProcessing = async () => {
    if (!isRedisAvailable()) return;

    const processing = await redis.hgetall(AUTH_PROCESSING_KEY);
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [c, data] of Object.entries(processing)) {
        try {
            const parsed = JSON.parse(data);
            if (now - parsed.timestamp > staleThreshold) {
                await redis.hdel(AUTH_PROCESSING_KEY, c);
                localLog(`Cleaned up stale processing mark for c=${c}`);
            }
        } catch (e) {
            // Invalid data, delete it
            await redis.hdel(AUTH_PROCESSING_KEY, c);
        }
    }
};

// ==================== DISTRIBUTED PROCESSING LOCK ====================

// Acquire processing lock (distributed lock for queue processing)
export const acquireProcessingLock = async (shardId) => {
    if (!isRedisAvailable()) return false;
    
    try {
        // SET key value NX EX ttl - only sets if key doesn't exist (NX), with expiry (EX)
        // This ensures only one shard can hold the lock at a time
        const result = await redis.set(AUTH_PROCESSING_LOCK, String(shardId), 'NX', 'EX', LOCK_TTL);
        return result === 'OK';
    } catch (e) {
        localError("Failed to acquire processing lock:", e);
        return false;
    }
};

// Release processing lock
export const releaseProcessingLock = async () => {
    if (!isRedisAvailable()) return;
    
    try {
        await redis.del(AUTH_PROCESSING_LOCK);
    } catch (e) {
        localError("Failed to release processing lock:", e);
    }
};

// ==================== COUNTER OPERATIONS ====================

const COUNTER_KEY = "skinpeek:auth:counter";

// Get and increment counter (atomic)
export const getNextCounter = async () => {
    if (!isRedisAvailable()) throw new Error("Redis not available");
    return await redis.incr(COUNTER_KEY);
};

// ==================== PUB/SUB FOR ALERTS ====================

const ALERT_CHANNEL = "skinpeek:alerts";

// Publish alert to all shards
export const publishAlert = async (alertData) => {
    if (!isRedisAvailable()) return;
    await redis.publish(ALERT_CHANNEL, JSON.stringify(alertData));
};

// Subscribe to alerts
export const subscribeToAlerts = async (callback) => {
    if (!subscriber) return;

    await subscriber.subscribe(ALERT_CHANNEL);
    subscriber.on('message', (channel, message) => {
        if (channel === ALERT_CHANNEL) {
            try {
                const data = JSON.parse(message);
                callback(data);
            } catch (e) {
                localError("Failed to parse alert message:", e);
            }
        }
    });
};

// ==================== SHOP CACHE OPERATIONS ====================

const SHOP_CACHE_PREFIX = "skinpeek:shop:";
const SHOP_CACHE_EXPIRY = 24 * 60 * 60; // 24 hours

// Store shop in Redis
export const setShopCache = async (userId, accountIndex, shopData) => {
    if (!isRedisAvailable()) return;
    
    const key = `${SHOP_CACHE_PREFIX}${userId}:${accountIndex}`;
    await redis.setex(key, SHOP_CACHE_EXPIRY, JSON.stringify(shopData));
};

// Get shop from Redis
export const getShopCache = async (userId, accountIndex) => {
    if (!isRedisAvailable()) return null;
    
    const key = `${SHOP_CACHE_PREFIX}${userId}:${accountIndex}`;
    const data = await redis.get(key);
    
    if (!data) return null;
    
    try {
        return JSON.parse(data);
    } catch (e) {
        localError("Failed to parse shop cache:", e);
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
        return data ? parseInt(data) : null;
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
};

// ==================== SHOP DATA CACHE ====================

const SHOPDATA_PREFIX = "skinpeek:shopdata:";
const SHOPDATA_TTL = 25 * 3600; // 25 hours (slightly more than daily shop reset)

export const setShopData = async (puuid, shopCache) => {
    if (!isRedisAvailable()) return;
    await redis.setex(`${SHOPDATA_PREFIX}${puuid}`, SHOPDATA_TTL, JSON.stringify(shopCache));
};

export const getShopData = async (puuid) => {
    if (!isRedisAvailable()) return null;
    const data = await redis.get(`${SHOPDATA_PREFIX}${puuid}`);
    if (!data) return null;
    try { return JSON.parse(data); } catch(e) { return null; }
};

export const deleteShopData = async (puuid) => {
    if (!isRedisAvailable()) return;
    try { await redis.del(`${SHOPDATA_PREFIX}${puuid}`); } catch(e) {}
};

// ==================== HEALTH CHECK ====================

export const redisHealthCheck = async () => {
    if (!isRedisAvailable()) return { healthy: false, error: "Not connected" };

    try {
        const start = Date.now();
        await redis.ping();
        const latency = Date.now() - start;

        const queueLength = await getAuthQueueLength();
        const memory = await redis.info('memory');

        return {
            healthy: true,
            latency,
            queueLength,
            memory: memory.split('\n').find(l => l.startsWith('used_memory_human:'))?.split(':')[1]?.trim()
        };
    } catch (e) {
        return { healthy: false, error: e.message };
    }
};
