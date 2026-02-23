import {checkAlerts, debugCheckAlerts, sendAlert, sendCredentialsExpired, sendDailyShop} from "../discord/alerts.js";
import {loadConfig} from "./config.js";
import {client, destroyTasks, scheduleTasks} from "../discord/bot.js";
import {addMessagesToLog, localLog} from "./logger.js";
import {loadSkinsJSON} from "../valorant/cache.js";
import {handleMQRequest, handleMQResponse} from "./multiqueue.js";

let allShardsReadyCb;
let allShardsReadyPromise = new Promise(r => allShardsReadyCb = r);

export const areAllShardsReady = () => {
    return !client.shard || allShardsReadyPromise === null;
}

export const sendShardMessage = async (message) => {
    if(!client.shard) return;

    await allShardsReadyPromise;

    if(message.type !== "logMessages") localLog(`Sending message to other shards: ${JSON.stringify(message).substring(0, 100)}`);

    // I know this is a weird way of doing this, but trust me
    // client.shard.send() did not want to work for the life of me
    // and this solution seems to work, so should be fine lol
    await client.shard.broadcastEval((client, context) => {
        client.skinPeekShardMessageReceived(context.message);
    }, {context: {message}});
}

/**
 * Send a shard message only to the shard that has a specific channel in its cache.
 * Returns true if any shard processed it, false if no shard has the channel.
 */
export const sendShardMessageForChannel = async (message, channelId) => {
    if(!client.shard) return false;

    await allShardsReadyPromise;

    localLog(`Sending targeted message for channel ${channelId}: ${JSON.stringify(message).substring(0, 100)}`);

    const results = await client.shard.broadcastEval((client, context) => {
        if (client.channels.cache.has(context.channelId)) {
            client.skinPeekShardMessageReceived(context.message);
            return true;
        }
        return false;
    }, {context: {message, channelId}});

    return results.some(r => r === true);
}

const receiveShardMessage = async (message) => {
    //oldLog(`Received shard message ${JSON.stringify(message).substring(0, 100)}`);
    switch(message.type) {
        case "shardsReady":
            // also received when a shard dies and respawns
            if(allShardsReadyPromise === null) return;

            localLog(`All shards are ready!`);
            allShardsReadyPromise = null;
            allShardsReadyCb();
            break;
        case "mqrequest":
            await handleMQRequest(message);
            break;
        case "mqresponse":
            await handleMQResponse(message);
            break;
        case "alert":
            await sendAlert(message.id, message.account, message.alerts, message.expires, false, message.alertsLength);
            break;
        case "dailyShop":
            await sendDailyShop(message.id, message.shop, message.channelId, message.valorantUser, false);
            break;
        case "credentialsExpired":
            await sendCredentialsExpired(message.id, message.alert, false);
            break;
        case "checkAlerts":
            await checkAlerts();
            break;
        case "debugCheckAlerts":
            await debugCheckAlerts();
            break;
        case "configReload":
            loadConfig("config.json", false); // Don't save during reload to avoid race conditions
            destroyTasks();
            scheduleTasks();
            break;
        case "skinsReload":
            await loadSkinsJSON();
            break;
        case "priceUpdate":
            // Non-zero shards send discovered prices to shard 0 for persistence
            if (client.shard && client.shard.ids[0] === 0) {
                const {mergePrices} = await import("../valorant/cache.js");
                mergePrices(message.prices);
            }
            break;
        case "emojiCacheWarm":
            // Shard 0 broadcasts its emoji cache snapshot so other shards skip their own fetch
            if (client.shard && client.shard.ids[0] !== 0) {
                const {populateEmojiCacheFromSnapshot} = await import("../discord/emoji.js");
                populateEmojiCacheFromSnapshot(message.snapshot);
            }
            break;
        case "settingsInvalidate": {
            const {clearSettingsCache} = await import("./settings.js");
            clearSettingsCache(message.userId);
            break;
        }
        case "logMessages":
            addMessagesToLog(message.messages);
            break;
        case "riotVersionData":
            const {setRiotVersionData} = await import("./util.js");
            setRiotVersionData(message.data);
            localLog(`Received Riot version data from shard 0: ${message.data.riotClientVersion}`);
            break;
        case "processExit":
            process.exit();
            break;
    }
};

setTimeout(() => client.skinPeekShardMessageReceived = receiveShardMessage);
