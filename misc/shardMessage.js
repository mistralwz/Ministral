import { loadConfig } from "./config.js";
import { localLog, localError } from "./logger.js";

let shardClient = null;
let allShardsReadyCb;
let allShardsReadyPromise = new Promise(r => allShardsReadyCb = r);

// Channel→shard mapping cache
const channelToShardCache = new Map();

export const setShardClient = (client) => {
    shardClient = client;
    if (shardClient) {
        shardClient.skinPeekShardMessageReceived = receiveShardMessage;
    }
};

export const areAllShardsReady = () => allShardsReadyPromise === null;

export const sendShardMessage = async (message) => {
    await allShardsReadyPromise;
    if (!shardClient?.shard) return;

    try {
        await shardClient.shard.broadcastEval(async (c, context) => {
            if (typeof c.skinPeekShardMessageReceived === "function") {
                try {
                    await c.skinPeekShardMessageReceived(context.message);
                } catch {}
            }
        }, { context: { message } });
    } catch (e) {
        localError("Error broadcasting shard message:", e);
    }
};

/**
 * Send a shard message only to the shard that has a specific channel in its cache.
 * Returns true if any shard processed it, false if no shard has the channel.
 */
export const sendShardMessageForChannel = async (message, channelId) => {
    await allShardsReadyPromise;
    if (!shardClient?.shard) return false;

    // Try targeted delivery to the cached shard first (single pass)
    const knownShard = channelToShardCache.get(channelId);
    if (knownShard != null) {
        try {
            const handled = await shardClient.shard.broadcastEval(async (c, context) => {
                if (c.channels.cache.has(context.channelId)) {
                    if (typeof c.skinPeekShardMessageReceived === "function") {
                        try {
                            await c.skinPeekShardMessageReceived(context.message);
                        } catch {}
                    }
                    return true;
                }
                return false;
            }, { context: { message, channelId }, shard: knownShard });

            if (handled) {
                localLog(`Targeted shard ${knownShard} for channel ${channelId}: ${JSON.stringify(message).substring(0, 100)}`);
                return true;
            }
            channelToShardCache.delete(channelId);
        } catch (e) {
            channelToShardCache.delete(channelId);
        }
    }

    localLog(`Broadcasting channel delivery for channel ${channelId}: ${JSON.stringify(message).substring(0, 100)}`);

    // Single-pass broadcast: checks channel AND delivers immediately on the winning shard
    try {
        const results = await shardClient.shard.broadcastEval(async (c, context) => {
            if (c.channels.cache.has(context.channelId)) {
                if (typeof c.skinPeekShardMessageReceived === "function") {
                    try {
                        await c.skinPeekShardMessageReceived(context.message);
                    } catch {}
                }
                return true;
            }
            return false;
        }, { context: { message, channelId } });

        const matchIndex = results.findIndex(r => r === true);
        if (matchIndex !== -1) {
            channelToShardCache.set(channelId, matchIndex);
            localLog(`Delivered shard message to winning shard ${matchIndex} for channel ${channelId}`);
            return true;
        }
    } catch (e) {
        localError(`Error broadcasting message for channel ${channelId}:`, e);
    }

    return false;
};

const customShardMessageHandlers = [];
export const onShardMessage = (handler) => {
    customShardMessageHandlers.push(handler);
};

export const receiveShardMessage = async (message) => {
    if (!message) return;

    if (message.type === "shardsReady") {
        if (allShardsReadyPromise !== null) {
            localLog("All shards are ready!");
            allShardsReadyPromise = null;
            if (typeof allShardsReadyCb === "function") allShardsReadyCb();
        }
        return;
    }

    for (const handler of customShardMessageHandlers) {
        try {
            const handled = await handler(message);
            if (handled) return;
        } catch (e) {
            localError("Error handling shard message:", e);
        }
    }
};
