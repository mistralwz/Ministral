import { isMainThread } from 'worker_threads';
import { ShardingManager } from 'discord.js';
import { loadConfig } from "./misc/config.js";

if (isMainThread) {
    const config = loadConfig();

    if (config) {
        const { initUserDatabase, closeUserDatabase } = await import("./misc/userDatabase.js");
        if (!initUserDatabase()) {
            console.error("User database initialization failed in main thread. Cannot spawn shards.");
            process.exit(1);
        }
        closeUserDatabase();
    }

    const manager = new ShardingManager('./SkinPeek.js', {
        token: config.token,
        mode: "worker",
        totalShards: config.shards || "auto"
    });

    let allShardsReady = false;
    const sendAllShardsReady = () => {
        manager.broadcastEval((client) => client.skinPeekShardMessageReceived({ type: "shardsReady" }));
    }

    console.log("[Shards] Starting spawn");

    manager.on("shardCreate", (shard) => {
        console.log(`[Shard ${shard.id}] Spawned at ${new Date().toISOString()}`);

        shard.on("death", () => {
            console.error(`[Shard ${shard.id}] Died at ${new Date().toISOString()}`);
        });

        shard.on("disconnect", () => {
            console.warn(`[Shard ${shard.id}] Discord Websocket Disconnected at ${new Date().toISOString()}`);
        });

        shard.on("reconnecting", () => {
            console.log(`[Shard ${shard.id}] Attempting to reconnect at ${new Date().toISOString()}`);
        });

        shard.on("error", (error) => {
            console.error(`[Shard ${shard.id}] Error at ${new Date().toISOString()}:`, error);
        });

        if (allShardsReady) {
            // this shard was respawned, tell it that all shards are ready
            console.log(`[Shards] Sending shardsReady to respawned shard ${shard.id} at ${new Date().toISOString()}`);
            shard.on("ready", () => {
                console.log(`[Shard ${shard.id}] Ready at ${new Date().toISOString()}`);
                sendAllShardsReady();
            });
        }

        shard.on("message", (message) => {
            // console.log(`[Shard ${shard.id}] Message: ${JSON.stringify(message)}`);
            if (message === "shardReady" && allShardsReady) sendAllShardsReady();
            if (message === "processExit" || message?.type === "processExit") {
                console.log(`[Shards] Process exit requested by shard ${shard.id}. Exiting process for restart...`);
                setTimeout(() => process.exit(0), 1000);
            }
        });
    });

    manager.on("error", (error) => {
        console.error("[Shards] Manager error:", error);
    });

    manager.spawn({
        timeout: config.shardReadyTimeout,
    }).then(() => {
        allShardsReady = true;
        console.log(`[Shards] All shards spawned and ready at ${new Date().toISOString()}`);
        sendAllShardsReady();
    }).catch(err => {
        console.error("[Shards] Failed to spawn shards:", err);
        process.exit(1);
    });
} else {
    // Worker Thread Logic
    const { startBot } = await import("./discord/bot.js");
    const { loadLogger } = await import("./misc/logger.js");
    const { initUserDatabase, closeUserDatabase } = await import("./misc/userDatabase.js");

    const config = loadConfig();
    if (config) {
        loadLogger();

        if (!initUserDatabase()) {
            console.error("User database initialization failed. Cannot start bot.");
            process.exit(1);
        }

        const handleShutdown = () => {
            closeUserDatabase();
            process.exit(0);
        };
        process.on("SIGINT", handleShutdown);
        process.on("SIGTERM", handleShutdown);

        startBot();
    }
}
