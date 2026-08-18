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

    await shardClient.shard.broadcastEval((c, context) => {
        if (typeof c.skinPeekShardMessageReceived === "function") {
            c.skinPeekShardMessageReceived(context.message);
        }
    }, { context: { message } });
};

/**
 * Send a shard message only to the shard that has a specific channel in its cache.
 * Returns true if any shard processed it, false if no shard has the channel.
 */
export const sendShardMessageForChannel = async (message, channelId) => {
    await allShardsReadyPromise;
    if (!shardClient?.shard) return false;

    // Try targeted delivery to the cached shard first
    const knownShard = channelToShardCache.get(channelId);
    if (knownShard != null) {
        try {
            const [hasChannel] = await shardClient.shard.broadcastEval((c, context) => {
                return c.channels.cache.has(context.channelId);
            }, { context: { channelId }, shard: knownShard });

            if (hasChannel) {
                localLog(`Targeted shard ${knownShard} for channel ${channelId}: ${JSON.stringify(message).substring(0, 100)}`);
                await shardClient.shard.broadcastEval((c, context) => {
                    if (typeof c.skinPeekShardMessageReceived === "function") {
                        c.skinPeekShardMessageReceived(context.message);
                    }
                }, { context: { message }, shard: knownShard });
                return true;
            }
            channelToShardCache.delete(channelId);
        } catch (e) {
            channelToShardCache.delete(channelId);
        }
    }

    localLog(`Broadcasting channel check for channel ${channelId}: ${JSON.stringify(message).substring(0, 100)}`);

    // Full broadcast fallback
    const results = await shardClient.shard.broadcastEval((c, context) => {
        return c.channels.cache.has(context.channelId);
    }, { context: { channelId } });

    const matchIndex = results.findIndex(r => r === true);
    if (matchIndex !== -1) {
        channelToShardCache.set(channelId, matchIndex);
        localLog(`Delivering shard message to winning shard ${matchIndex} for channel ${channelId}`);
        try {
            await shardClient.shard.broadcastEval((c, context) => {
                if (typeof c.skinPeekShardMessageReceived === "function") {
                    c.skinPeekShardMessageReceived(context.message);
                }
            }, { context: { message }, shard: matchIndex });
            return true;
        } catch (e) {
            channelToShardCache.delete(channelId);
            return false;
        }
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
