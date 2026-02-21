import {asyncReadFile, canCreateEmojis, emojiToString, externalEmojisAllowed} from "../misc/util.js";
import config from "../misc/config.js";
import {client} from "./bot.js";
import {s} from "../misc/languages.js";

const VPEmojiName = "ValPointsIcon";
const VPEmojiFilename = "assets/vp.png"; // https://media.valorant-api.com/currencies/85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741/largeicon.png

const RadEmojiName = "RadianiteIcon";
const RadEmojiFilename = "assets/rad.png"; // https://media.valorant-api.com/currencies/e59aa87c-4cbf-517a-5983-6e81511be9b7/displayicon.png

const KCEmojiName = "KingdomCreditIcon";
const KCEmojiFilename = "assets/kc.png"; // https://media.valorant-api.com/currencies/85ca954a-41f2-ce94-9b45-8ca3dd39a00d/displayicon.png

// the timestamp of the last time the emoji cache was updated for each guild
const lastEmojiFetch = {};

// a cache for emoji objects (note: due to sharding, might just be JSON representations of the emoji)
const emojiCache = {};

export const VPEmoji = async (interaction, channel=interaction.channel) => emojiToString(await getOrCreateEmoji(channel, VPEmojiName, VPEmojiFilename)) || s(interaction).info.PRICE;
export const RadEmoji = async (interaction, channel=interaction.channel) => emojiToString(await getOrCreateEmoji(channel, RadEmojiName, RadEmojiFilename));
export const KCEmoji = async (interaction, channel=interaction.channel) => emojiToString(await getOrCreateEmoji(channel, KCEmojiName, KCEmojiFilename));

export const rarityEmoji = async (channel, name, icon) => emojiToString(await getOrCreateEmoji(channel, `${name}Rarity`, icon));

/**
 * Returns true if rarity emojis can be rendered in the given channel.
 * This is the case when:
 *   - External emojis are permitted (@everyone has UseExternalEmojis), OR
 *   - The guild already has locally-uploaded rarity emojis (same-name emojis previously added).
 */
export const rarityEmojisAvailable = (channel) => {
    if(externalEmojisAllowed(channel)) return true;
    // External emojis are blocked — check if any rarity emoji already lives in this guild
    const guild = channel && channel.guild;
    if(!guild) return true;
    return guild.emojis.cache.some(e => e.name && e.name.endsWith("Rarity") && e.available);
};

const getOrCreateEmoji = async (channel, name, filenameOrUrl) => {
    if(!name || !filenameOrUrl) return;

    const guild = channel && channel.guild;

    // see if emoji exists already
    const emoji = emojiInGuild(guild, name);
    if(emoji && emoji.available) return addEmojiToCache(emoji);

    // check in other guilds
    const externalAllowed = externalEmojisAllowed(channel);
    if(externalAllowed) {
        if(config.useEmojisFromServer) {
            try {
                const emojiGuild = await client.guilds.fetch(config.useEmojisFromServer);
                if(!emojiGuild) console.error("useEmojisFromServer server not found! Either the ID is incorrect or I am not in that server anymore!");
                else {
                    await updateEmojiCache(emojiGuild);
                    const emoji = emojiInGuild(emojiGuild, name);
                    if(emoji && emoji.available) return addEmojiToCache(emoji);
                }
            } catch(e) {}
        }

        const cachedEmoji = emojiCache[name];
        if(cachedEmoji) return cachedEmoji;

        for(const otherGuild of client.guilds.cache.values()) {
            const emoji = emojiInGuild(otherGuild, name);
            if(emoji && emoji.available) return addEmojiToCache(emoji);
        }

        if(client.shard) {
            const results = await channel.client.shard.broadcastEval(findEmoji, { context: { name } });
            const emoji = results.find(e => e);
            if(emoji) return addEmojiToCache(emoji);
        }
    }

    // couldn't find usable emoji, try to create it only in the configured server
    if(config.useEmojisFromServer) {
        try {
            const emojiGuild = await client.guilds.fetch(config.useEmojisFromServer);
            if(emojiGuild) return addEmojiToCache(await createEmoji(emojiGuild, name, filenameOrUrl));
        } catch(e) {
            console.error(`Failed to create emoji in useEmojisFromServer guild: ${e.message}`);
        }
    } else {
        // No emoji server configured - log notice instead of creating emojis everywhere
        console.log(`Emoji ${name} not found. Configure 'useEmojisFromServer' in config.json to use custom emojis.`);
    }
}

const emojiInGuild = (guild, name) => {
    return guild && guild.emojis.cache.find(emoji => emoji.name === name);
}

const createEmoji = async (guild, name, filenameOrUrl) => {
    if(!guild || !name || !filenameOrUrl) return;
    if(!canCreateEmojis(guild)) {
        console.log(`Don't have permission to create emoji ${name} in guild ${guild.name}!`);
        console.log(`Make sure the bot has 'Manage Emojis and Stickers' permission in that server.`);
        return;
    }

    await updateEmojiCache(guild);
    if(guild.emojis.cache.filter(e => !e.animated).size >= maxEmojis(guild))
        return console.log(`Emoji limit of ${maxEmojis(guild)} reached for ${guild.name} while uploading ${name}!`);

    console.log(`Uploading emoji ${name} in ${guild.name}...`);
    try {
        const attachment = await resolveFilenameOrUrl(filenameOrUrl)
        return await guild.emojis.create({name, attachment});
    } catch(e) {
        console.error(`Could not create ${name} emoji in ${guild.name}!`);
        console.error(`Make sure the bot has 'Manage Emojis and Stickers' permission and there are available emoji slots.`);
        console.error(`${e.name}: ${e.message}`);
    }
}

const resolveFilenameOrUrl = async (filenameOrUrl) => {
    if(filenameOrUrl.startsWith("http"))
        return filenameOrUrl;
    return await asyncReadFile(filenameOrUrl);
}

const updateEmojiCache = async (guild) => {
    if(!guild) return;
    if(!lastEmojiFetch[guild.id]) lastEmojiFetch[guild.id] = 0;
    if(Date.now() - lastEmojiFetch[guild.id] < config.emojiCacheExpiration) return; // don't update emoji cache multiple times per second

    await guild.emojis.fetch();

    lastEmojiFetch[guild.id] = Date.now();
    console.log(`Updated emoji cache for ${guild.name}`);
}

const addEmojiToCache = (emoji) => {
    if(emoji) emojiCache[emoji.name] = emoji;
    return emoji;
}

const findEmoji = (c, { name }) => {
    return c.emojis.cache.get(name) || c.emojis.cache.find(e => e.name.toLowerCase() === name.toLowerCase());
}

const maxEmojis = (guild) => {
    switch(guild.premiumTier) {
        case "NONE": return 50;
        case "TIER_1": return 100;
        case "TIER_2": return 150;
        case "TIER_3": return 250;
    }
}
