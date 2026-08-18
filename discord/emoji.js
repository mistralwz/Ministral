import { fetch } from "../misc/util.js";
import { s } from "../misc/languages.js";
import fs from "node:fs/promises";

const VPEmojiName = "ValPointsIcon";
const VPEmojiFilename = "assets/vp.png";

const RadEmojiName = "RadianiteIcon";
const RadEmojiFilename = "assets/rad.png";

const KCEmojiName = "KingdomCreditIcon";
const KCEmojiFilename = "assets/kc.png";

const pendingCreations = {};

let emojiClient = null;
export const setEmojiClient = (client) => {
    emojiClient = client;
};

const getClient = (interaction = null) => {
    return interaction?.client || emojiClient;
};

export const emojiToString = (emoji) => emoji && `<:${emoji.name}:${emoji.id}>`;

export const VPEmoji = async (interaction) => emojiToString(await getOrCreateEmoji(VPEmojiName, VPEmojiFilename, interaction)) || s(interaction).info.PRICE;
export const RadEmoji = async (interaction) => emojiToString(await getOrCreateEmoji(RadEmojiName, RadEmojiFilename, interaction));
export const KCEmoji = async (interaction) => emojiToString(await getOrCreateEmoji(KCEmojiName, KCEmojiFilename, interaction));

export const rarityEmoji = async (name, icon, interaction = null) => emojiToString(await getOrCreateEmoji(`${name}Rarity`, icon, interaction));

export const agentEmoji = async (agentName, iconUrl, interaction = null) => {
    if (!agentName || !iconUrl) return null;
    const emojiName = ("Agent_" + agentName.replace(/[^a-zA-Z0-9]/g, "_")).slice(0, 32);
    return getOrCreateEmoji(emojiName, iconUrl, interaction);
};

export const queueEmoji = async (queueName, iconUrl, interaction = null) => {
    if (!queueName || !iconUrl) return null;
    const emojiName = ("Queue_" + queueName.replace(/[^a-zA-Z0-9]/g, "_")).slice(0, 32);
    return getOrCreateEmoji(emojiName, iconUrl, interaction);
};

export const rankEmoji = async (tier, iconUrl, interaction = null) => {
    if (tier == null || !iconUrl) return null;
    return getOrCreateEmoji(`Rank_${tier}`, iconUrl, interaction);
};

const getOrCreateEmoji = async (name, filenameOrUrl, interaction = null) => {
    if (!name || !filenameOrUrl) return null;

    const client = getClient(interaction);
    if (!client?.application?.emojis) return null;

    let existing = client.application.emojis.cache.find(e => e.name === name);
    if (existing) return existing;

    const appEmojis = await client.application.emojis.fetch();
    existing = appEmojis.find(e => e.name === name);
    if (existing) return existing;

    if (pendingCreations[name]) return await pendingCreations[name];

    try {
        pendingCreations[name] = createApplicationEmoji(name, filenameOrUrl, client);
        const created = await pendingCreations[name];
        delete pendingCreations[name];
        return created;
    } catch (e) {
        delete pendingCreations[name];
        console.error(`Failed to create application emoji ${name}: ${e.message}`);
        return null;
    }
};

const createApplicationEmoji = async (name, filenameOrUrl, client) => {
    if (!name || !filenameOrUrl || !client?.application?.emojis) return null;

    if (client.application.emojis.cache.filter(e => !e.animated).size >= 2000) {
        console.log(`Application Emoji limit of 2000 reached while uploading ${name}!`);
        return null;
    }

    console.log(`Uploading Application Emoji: ${name}...`);
    try {
        const attachment = await resolveFilenameOrUrl(filenameOrUrl);
        return await client.application.emojis.create({ name, attachment });
    } catch (e) {
        console.error(`Could not create application emoji ${name}:`, e);
        return null;
    }
};

const resolveFilenameOrUrl = async (filenameOrUrl) => {
    if (filenameOrUrl.startsWith("http")) return filenameOrUrl;
    return await fs.readFile(filenameOrUrl);
};

export const warmEmojiCache = async (client = null) => {
    const c = client || getClient();
    if (!c?.application?.emojis) return null;

    try {
        const appEmojis = await c.application.emojis.fetch();
        console.log(`Warmed application emoji cache with ${appEmojis.size} emojis.`);

        if (c.shard && c.shard.ids[0] !== 0) return {};

        console.log("Checking for missing default emojis...");

        await getOrCreateEmoji(VPEmojiName, VPEmojiFilename, { client: c });
        await getOrCreateEmoji(RadEmojiName, RadEmojiFilename, { client: c });
        await getOrCreateEmoji(KCEmojiName, KCEmojiFilename, { client: c });

        try {
            const agentReq = await fetch("https://valorant-api.com/v1/agents?isPlayableCharacter=true");
            if (agentReq.statusCode === 200) {
                const agents = JSON.parse(agentReq.body).data;
                for (const agent of agents) {
                    if (agent.displayName && agent.displayIcon) {
                        const emojiName = ("Agent_" + agent.displayName.replace(/[^a-zA-Z0-9]/g, "_")).slice(0, 32);
                        await getOrCreateEmoji(emojiName, agent.displayIcon, { client: c });
                    }
                }
            }
        } catch (e) {
            console.error("Agent bootstrap failed", e);
        }

        try {
            const rarityReq = await fetch("https://valorant-api.com/v1/contenttiers");
            if (rarityReq.statusCode === 200) {
                const rarities = JSON.parse(rarityReq.body).data;
                for (const rarity of rarities) {
                    if (rarity.devName && rarity.displayIcon) {
                        await getOrCreateEmoji(`${rarity.devName}Rarity`, rarity.displayIcon, { client: c });
                    }
                }
            }
        } catch (e) {
            console.error("Rarity bootstrap failed", e);
        }

        try {
            const rankReq = await fetch("https://valorant-api.com/v1/competitivetiers");
            if (rankReq.statusCode === 200) {
                const episodes = JSON.parse(rankReq.body).data;
                const latest = episodes[episodes.length - 1];
                if (latest && latest.tiers) {
                    for (const tier of latest.tiers) {
                        if (tier.tier >= 3 && tier.largeIcon) {
                            await getOrCreateEmoji(`Rank_${tier.tier}`, tier.largeIcon, { client: c });
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Rank bootstrap failed", e);
        }

        console.log("Emoji bootstrap complete.");
        return {};
    } catch (e) {
        console.error(`Failed to warm application emoji cache: ${e.message}`);
        return null;
    }
};
