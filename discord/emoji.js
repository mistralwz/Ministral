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

// negative cache: maps emoji name -> expiry timestamp for emojis confirmed not to exist
const negativeCache = {};
const NEGATIVE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const VPEmoji = async (interaction, channel=interaction.channel) => emojiToString(await getOrCreateEmoji(channel, VPEmojiName, VPEmojiFilename)) || s(interaction).info.PRICE;
export const RadEmoji = async (interaction, channel=interaction.channel) => emojiToString(await getOrCreateEmoji(channel, RadEmojiName, RadEmojiFilename));
export const KCEmoji = async (interaction, channel=interaction.channel) => emojiToString(await getOrCreateEmoji(channel, KCEmojiName, KCEmojiFilename));

export const rarityEmoji = async (channel, name, icon) => emojiToString(await getOrCreateEmoji(channel, `${name}Rarity`, icon));

/**
 * Resolve (and auto-upload) an agent portrait emoji.
 * @param {Channel} channel   The interaction channel (for permission checks)
 * @param {string}  agentName Display name, e.g. "KAY/O"
 * @param {string}  iconUrl   URL from valorant-api.com
 */
export const agentEmoji = async (channel, agentName, iconUrl) => {
    if (!agentName || !iconUrl) return null;
    // Discord emoji names: 2-32 chars, [a-zA-Z0-9_] only
    const emojiName = ("Agent_" + agentName.replace(/[^a-zA-Z0-9]/g, "_")).slice(0, 32);
    return getOrCreateEmoji(channel, emojiName, iconUrl);
};

/**
 * Resolve (and auto-upload) a competitive rank emoji.
 * @param {Channel} channel  The interaction channel
 * @param {number}  tier     Valorant tier number (3–27)
 * @param {string}  iconUrl  URL from valorant-api.com
 */
export const rankEmoji = async (channel, tier, iconUrl) => {
    if (!tier || !iconUrl) return null;
    return getOrCreateEmoji(channel, `Rank_${tier}`, iconUrl);
};

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

        // Skip broadcastEval if we recently confirmed this emoji doesn't exist
        if(negativeCache[name] && Date.now() < negativeCache[name]) return null;

        if(client.shard) {
            const results = await channel.client.shard.broadcastEval(findEmoji, { context: { name } });
            const emoji = results.find(e => e);
            if(emoji) return addEmojiToCache(emoji);
            // Cache the miss to avoid repeated broadcastEval for emojis that genuinely don't exist
            negativeCache[name] = Date.now() + NEGATIVE_CACHE_TTL;
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
    if(emoji) {
        emojiCache[emoji.name] = emoji;
        // Clear any negative cache entry now that we have the real emoji
        delete negativeCache[emoji.name];
    }
    return emoji;
}

/**
 * Pre-warm the emoji cache at bot startup using the configured emoji server.
 * This prevents the first interaction on each shard from doing a broadcastEval.
 */
export const warmEmojiCache = async () => {
    if(!config.useEmojisFromServer) return;
    try {
        const emojiGuild = await client.guilds.fetch(config.useEmojisFromServer);
        if(!emojiGuild) return;
        await updateEmojiCache(emojiGuild);
        for(const emoji of emojiGuild.emojis.cache.values()) {
            if(emoji.available) addEmojiToCache(emoji);
        }
        console.log(`Warmed emoji cache with ${Object.keys(emojiCache).length} emojis from ${emojiGuild.name}`);
    } catch(e) {
        console.error(`Failed to warm emoji cache: ${e.message}`);
    }
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
