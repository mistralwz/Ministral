import { asyncReadFile, emojiToString, fetch } from "../misc/util.js";
import { client } from "./bot.js";
import { s } from "../misc/languages.js";

const VPEmojiName = "ValPointsIcon";
const VPEmojiFilename = "assets/vp.png"; // https://media.valorant-api.com/currencies/85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741/largeicon.png

const RadEmojiName = "RadianiteIcon";
const RadEmojiFilename = "assets/rad.png"; // https://media.valorant-api.com/currencies/e59aa87c-4cbf-517a-5983-6e81511be9b7/displayicon.png

const KCEmojiName = "KingdomCreditIcon";
const KCEmojiFilename = "assets/kc.png"; // https://media.valorant-api.com/currencies/85ca954a-41f2-ce94-9b45-8ca3dd39a00d/displayicon.png

// tracks in-flight emoji creations to prevent duplicate uploads from concurrent requests
const pendingCreations = {};

export const VPEmoji = async (interaction) => emojiToString(await getOrCreateEmoji(VPEmojiName, VPEmojiFilename)) || s(interaction).info.PRICE;
export const RadEmoji = async (interaction) => emojiToString(await getOrCreateEmoji(RadEmojiName, RadEmojiFilename));
export const KCEmoji = async (interaction) => emojiToString(await getOrCreateEmoji(KCEmojiName, KCEmojiFilename));

export const rarityEmoji = async (channel, name, icon) => emojiToString(await getOrCreateEmoji(`${name}Rarity`, icon));

export const agentEmoji = async (channel, agentName, iconUrl) => {
    if (!agentName || !iconUrl) return null;
    const emojiName = ("Agent_" + agentName.replace(/[^a-zA-Z0-9]/g, "_")).slice(0, 32);
    return getOrCreateEmoji(emojiName, iconUrl);
};

export const rankEmoji = async (channel, tier, iconUrl) => {
    if (tier == null || !iconUrl) return null;
    return getOrCreateEmoji(`Rank_${tier}`, iconUrl);
};

export const rarityEmojisAvailable = () => {
    return true; // Application Emojis bypass channel permissions
};

const getOrCreateEmoji = async (name, filenameOrUrl) => {
    if (!name || !filenameOrUrl) return;

    if (!client.application || !client.application.emojis) {
        return null; // Not ready or not a bot application
    }

    // Try finding the emoji in application emojis cache first
    let existing = client.application.emojis.cache.find(e => e.name === name);
    if (existing) return existing;

    // Fallback to fetching
    const appEmojis = await client.application.emojis.fetch();
    existing = appEmojis.find(e => e.name === name);
    if (existing) return existing;

    // Use pendingCreations to prevent duplicate uploads from concurrent requests
    if (pendingCreations[name]) return await pendingCreations[name];

    try {
        pendingCreations[name] = createApplicationEmoji(name, filenameOrUrl);
        const created = await pendingCreations[name];
        delete pendingCreations[name];
        return created;
    } catch (e) {
        delete pendingCreations[name];
        console.error(`Failed to create application emoji ${name}: ${e.message}`);
        return null;
    }
}

const createApplicationEmoji = async (name, filenameOrUrl) => {
    if (!name || !filenameOrUrl) return null;

    if (client.application.emojis.cache.filter(e => !e.animated).size >= 2000) {
        console.log(`Application Emoji limit of 2000 reached while uploading ${name}!`);
        return null;
    }

    console.log(`Uploading Application Emoji: ${name}...`);
    try {
        const attachment = await resolveFilenameOrUrl(filenameOrUrl)
        return await client.application.emojis.create({ name, attachment });
    } catch (e) {
        console.error(`Could not create application emoji ${name}!`);
        console.error(`${e.name}: ${e.message}`);
        return null;
    }
}

const resolveFilenameOrUrl = async (filenameOrUrl) => {
    if (filenameOrUrl.startsWith("http"))
        return filenameOrUrl;
    return await asyncReadFile(filenameOrUrl);
}

export const warmEmojiCache = async () => {
    if (!client.application || !client.application.emojis) return null;

    try {
        const appEmojis = await client.application.emojis.fetch();
        console.log(`Warmed application emoji cache with ${appEmojis.size} emojis.`);

        // Only shard 0 bootstraps missing static emojis to avoid duplicate API calls
        if (client.shard && client.shard.ids[0] !== 0) return {};

        console.log("Checking for missing default emojis...");

        // 1. Currencies
        await getOrCreateEmoji(VPEmojiName, VPEmojiFilename);
        await getOrCreateEmoji(RadEmojiName, RadEmojiFilename);
        await getOrCreateEmoji(KCEmojiName, KCEmojiFilename);

        // 2. Agents
        try {
            const agentReq = await fetch("https://valorant-api.com/v1/agents?isPlayableCharacter=true");
            if (agentReq.statusCode === 200) {
                const agents = JSON.parse(agentReq.body).data;
                for (const agent of agents) {
                    if (agent.displayName && agent.displayIcon) {
                        const emojiName = ("Agent_" + agent.displayName.replace(/[^a-zA-Z0-9]/g, "_")).slice(0, 32);
                        await getOrCreateEmoji(emojiName, agent.displayIcon);
                    }
                }
            }
        } catch (e) { console.error("Agent bootstrap failed", e); }

        // 3. Rarities
        try {
            const rarityReq = await fetch("https://valorant-api.com/v1/contenttiers");
            if (rarityReq.statusCode === 200) {
                const rarities = JSON.parse(rarityReq.body).data;
                for (const rarity of rarities) {
                    if (rarity.devName && rarity.displayIcon) {
                        await getOrCreateEmoji(`${rarity.devName}Rarity`, rarity.displayIcon);
                    }
                }
            }
        } catch (e) { console.error("Rarity bootstrap failed", e); }

        // 4. Ranks
        try {
            const rankReq = await fetch("https://valorant-api.com/v1/competitivetiers");
            if (rankReq.statusCode === 200) {
                const episodes = JSON.parse(rankReq.body).data;
                const latest = episodes[episodes.length - 1];
                if (latest && latest.tiers) {
                    for (const tier of latest.tiers) {
                        if (tier.tier >= 3 && tier.largeIcon) {
                            await getOrCreateEmoji(`Rank_${tier.tier}`, tier.largeIcon);
                        }
                    }
                }
            }
        } catch (e) { console.error("Rank bootstrap failed", e); }

        console.log("Emoji bootstrap complete.");
        return {};
    } catch (e) {
        console.error(`Failed to warm application emoji cache: ${e.message}`);
        return null;
    }
}

export const populateEmojiCacheFromSnapshot = (snapshot) => {
    // Ignored in application emojis, they synchronize themselves
}
