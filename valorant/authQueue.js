import { redeemCookies } from "./auth.js";
import config from "../misc/config.js";
import { wait } from "../misc/util.js";
import {
    getNextCounter,
    pushAuthQueue,
    popAuthQueue,
    getAuthResult,
    storeAuthResult,
    getAuthQueueLength,
    markAuthProcessing,
    unmarkAuthProcessing,
    cleanupStaleProcessing,
    acquireProcessingLock,
    releaseProcessingLock
} from "../misc/redisQueue.js";
import { client } from "../discord/bot.js";

export const Operations = {
    COOKIES: "ck",
    NULL: "00"
}

let authQueueTimeout;

export const startAuthQueue = () => {
    clearTimeout(authQueueTimeout);
    if (config.useLoginQueue) {
        const runNext = async () => {
            await processAuthQueue();
            authQueueTimeout = setTimeout(runNext, config.loginQueueInterval);
        };
        authQueueTimeout = setTimeout(runNext, config.loginQueueInterval);

        // Cleanup stale processing marks every 5 minutes
        setInterval(cleanupStaleProcessing, 5 * 60 * 1000);
    }
}

export const queueCookiesLogin = async (id, cookies) => {
    if (!config.useLoginQueue) return await redeemCookies(id, cookies);

    const c = await getNextCounter();
    await pushAuthQueue({
        operation: Operations.COOKIES,
        c, id, cookies
    });
    console.log(`[Auth Queue] Added cookie login for user ${id} (c=${c})`);
    return { inQueue: true, c };
};

export const queueNullOperation = async (timeout) => {  // used for stress-testing the auth queue
    if (!config.useLoginQueue) {
        await wait(timeout);
        return { success: true };
    }

    const c = await getNextCounter();
    await pushAuthQueue({
        operation: Operations.NULL,
        c, timeout
    });
    console.log(`[Auth Queue] Added null operation with timeout ${timeout} (c=${c})`);
    return { inQueue: true, c };
};

export const processAuthQueue = async () => {
    if (!config.useLoginQueue) return;

    const shardId = client.shard.ids[0];

    // Only one shard across the cluster can hold the processing lock at a time
    const lockAcquired = await acquireProcessingLock(shardId);
    if (!lockAcquired) return;

    try {
        const item = await popAuthQueue();
        if (!item) {
            await releaseProcessingLock();
            return;
        }

        console.log(`[Shard ${shardId}] Processing auth queue item "${item.operation}" for ${item.id} (c=${item.c})`);

        await markAuthProcessing(item.c, shardId);

        let result;
        try {
            switch (item.operation) {
                case Operations.COOKIES:
                    result = await redeemCookies(item.id, item.cookies);
                    break;
                case Operations.NULL:
                    await wait(item.timeout);
                    result = { success: true };
                    break;
            }
        } catch (e) {
            result = { success: false, error: e.message };
        }

        await storeAuthResult(item.c, result);
        await unmarkAuthProcessing(item.c);

        console.log(`[Shard ${shardId}] Finished auth queue item "${item.operation}" for ${item.id} (c=${item.c})`);
    } finally {
        await releaseProcessingLock();
    }
};

export const getAuthQueueItemStatus = async (c) => {
    const result = await getAuthResult(c);
    if (result) {
        return { processed: true, result };
    }

    const queueLength = await getAuthQueueLength();
    return {
        processed: false,
        remaining: queueLength,
        timestamp: Math.round((Date.now() + ((queueLength + 1) * config.loginQueueInterval) + 2000) / 1000)
    };
};
