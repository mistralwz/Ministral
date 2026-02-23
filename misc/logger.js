import config from "./config.js";
import { escapeMarkdown } from "discord.js";
import { client } from "../discord/bot.js";
import { publishLogMessages } from "./redisQueue.js";

const messagesToLog = [];

const oldLog = console.log;
const oldError = console.error;

const shardString = () => `[${client.shard.ids[0]}] `;
export const localLog = (...args) => oldLog(shardString(), ...args);
export const localError = (...args) => oldError(shardString(), ...args);

export const loadLogger = () => {
    console.log = (...args) => {
        oldLog(shardString(), ...args);
        if (config.logToChannel && (config.verboseLogging || config.logUrls)) messagesToLog.push(shardString() + escapeMarkdown(args.join(" ")));
    }

    console.error = (...args) => {
        oldError(shardString(), ...args);
        if (config.logToChannel) messagesToLog.push("> " + shardString() + escapeMarkdown(args.map(e => (e instanceof Error ? e.stack : e.toString()).split('\n').join('\n> ' + shardString())).join(" ")));
    }
}

export const addMessagesToLog = (messages) => {
    if (!messages.length) return;

    const channel = client.channels.cache.get(config.logToChannel);
    if (!channel) {
        // oldLog(`[Shard ${client.shard.ids[0]}] addMessagesToLog: Ignoring, channel not here.`);
        return;
    }

    oldLog(`[Shard ${client.shard.ids[0]}] addMessagesToLog: Received ${messages.length} messages! Adding to queue...`);

    messagesToLog.push(...messages);
}

export const sendConsoleOutput = () => {
    try {
        if (!client || client.destroyed || !messagesToLog.length) return;

        oldLog(`[Shard ${client.shard.ids[0]}] logToChannel: Evaluating ${messagesToLog.length} messages.`);

        const channel = client.channels.cache.get(config.logToChannel);

        if (!channel) {
            oldLog(`[Shard ${client.shard.ids[0]}] logToChannel: Channel not in cache. Broadcasting via Redis...`);
            publishLogMessages([...messagesToLog]);
        }
        else if (channel) {
            while (messagesToLog.length) {
                let s = "";
                while (messagesToLog.length && s.length + messagesToLog[0].length < 2000) {
                    s += messagesToLog.shift() + "\n";
                }

                if (s.length === 0 && messagesToLog.length > 0) {
                    const longMessage = messagesToLog.shift();
                    s = longMessage.substring(0, 1990) + "...\n";
                    if (longMessage.length > 1990) {
                        messagesToLog.unshift("..." + longMessage.substring(1990));
                    }
                }

                if (s.trim().length > 0) {
                    channel.send(s).catch(err => {
                        oldError("Error when trying to send the console output to the channel!");
                        oldError(err);
                    });
                }
            }
        }

        messagesToLog.length = 0;
    } catch (e) {
        oldError("Error when trying to send the console output to the channel!");
        oldError(e);
    }
}
