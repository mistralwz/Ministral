import { rarityEmoji } from "../discord/emoji.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } from "discord.js";
import { getItem, getRarity } from "../valorant/cache.js";

import https from "https";
import http from "http";
import fs from "fs";
import { DEFAULT_LANG, l, valToDiscLang } from "./languages.js";
import { client } from "../discord/bot.js";
import { getUser } from "../valorant/auth.js";
import config from "./config.js";
import { checkRateLimit } from "./rateLimit.js";

const tlsCiphers = [
    'TLS_CHACHA20_POLY1305_SHA256',
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-ECDSA-AES128-SHA256',
    'ECDHE-RSA-AES128-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-AES128-SHA',
    'ECDHE-RSA-AES128-SHA',
    'ECDHE-ECDSA-AES256-SHA',
    'ECDHE-RSA-AES256-SHA',
    'RSA-PSK-AES128-GCM-SHA256',
    'RSA-PSK-AES256-GCM-SHA384',
    'RSA-PSK-AES128-CBC-SHA',
    'RSA-PSK-AES256-CBC-SHA',
];

const tlsSigAlgs = [
    'ecdsa_secp256r1_sha256',
    'rsa_pss_rsae_sha256',
    'rsa_pkcs1_sha256',
    'ecdsa_secp384r1_sha384',
    'rsa_pss_rsae_sha384',
    'rsa_pkcs1_sha384',
    'rsa_pss_rsae_sha512',
    'rsa_pkcs1_sha512',
    'rsa_pkcs1_sha1',
]

// Persistent keep-alive agents per hostname — eliminates repeated TLS handshakes (B1)
const keepAliveAgents = {};
const getKeepAliveAgent = (hostname) => {
    if (!keepAliveAgents[hostname]) {
        keepAliveAgents[hostname] = new https.Agent({
            keepAlive: true,
            maxSockets: 10,
            ciphers: tlsCiphers.join(':'),
            sigalgs: tlsSigAlgs.join(':'),
            minVersion: "TLSv1.3",
        });
    }
    return keepAliveAgents[hostname];
};

const channelGuildCache = new Map();
const CHANNEL_GUILD_CACHE_TTL_MS = 10 * 60 * 1000;

// all my homies hate node-fetch
export const fetch = (url, options = {}) => {
    if (config.logUrls) console.log("Fetching url " + url.substring(0, 200) + (url.length > 200 ? "..." : ""));

    return new Promise((resolve, reject) => {
        const hostname = new URL(url).hostname;
        const req = https.request(url, {
            agent: getKeepAliveAgent(hostname),
            method: options.method || "GET",
            headers: {
                cookie: "dummy=cookie", // set dummy cookie, helps with cloudflare 1020
                "Accept-Language": "en-US,en;q=0.5", // same as above
                "referer": "https://github.com/giorgi-o/SkinPeek", // to help other APIs see where the traffic is coming from
                ...options.headers
            },
            ciphers: tlsCiphers.join(':'),
            sigalgs: tlsSigAlgs.join(':'),
            minVersion: "TLSv1.3",
        }, resp => {
            const res = {
                statusCode: resp.statusCode,
                headers: resp.headers
            };
            let chunks = [];
            resp.on('data', (chunk) => chunks.push(chunk));
            resp.on('end', () => {
                res.body = Buffer.concat(chunks).toString(options.encoding || "utf8");
                resolve(res);
            });
            resp.on('error', err => {
                console.error(err);
                reject(err);
            });
        });
        req.write(options.body || "");
        req.end();
        req.on('error', err => {
            console.error(err);
            reject(err);
        });
    });
}

// file utils

export const asyncReadFile = (path) => {
    return new Promise(((resolve, reject) => {
        fs.readFile(path, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        })
    }));
}

export const asyncReadJSONFile = async (path) => {
    return JSON.parse((await asyncReadFile(path)).toString());
}

// riot utils

export const WeaponType = {
    Classic: "Classic",
    Shorty: "Shorty",
    Frenzy: "Frenzy",
    Ghost: "Ghost",
    Sheriff: "Sheriff",

    Stinger: "Stinger",
    Spectre: "Spectre",
    Bucky: "Bucky",
    Judge: "Judge",

    Bulldog: "Bulldog",
    Guardian: "Guardian",
    Phantom: "Phantom",
    Vandal: "Vandal",

    Marshal: "Marshal",
    Outlaw: "Outlaw",
    Operator: "Operator",
    Ares: "Ares",
    Odin: "Odin",
    Knife: "Knife",
}

export const WeaponTypeUuid = {
    [WeaponType.Odin]: "63e6c2b6-4a8e-869c-3d4c-e38355226584",
    [WeaponType.Ares]: "55d8a0f4-4274-ca67-fe2c-06ab45efdf58",
    [WeaponType.Vandal]: "9c82e19d-4575-0200-1a81-3eacf00cf872",
    [WeaponType.Bulldog]: "ae3de142-4d85-2547-dd26-4e90bed35cf7",
    [WeaponType.Phantom]: "ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a",
    [WeaponType.Judge]: "ec845bf4-4f79-ddda-a3da-0db3774b2794",
    [WeaponType.Bucky]: "910be174-449b-c412-ab22-d0873436b21b",
    [WeaponType.Frenzy]: "44d4e95c-4157-0037-81b2-17841bf2e8e3",
    [WeaponType.Classic]: "29a0cfab-485b-f5d5-779a-b59f85e204a8",
    [WeaponType.Ghost]: "1baa85b4-4c70-1284-64bb-6481dfc3bb4e",
    [WeaponType.Sheriff]: "e336c6b8-418d-9340-d77f-7a9e4cfe0702",
    [WeaponType.Shorty]: "42da8ccc-40d5-affc-beec-15aa47b42eda",
    [WeaponType.Operator]: "a03b24d3-4319-996d-0f8c-94bbfba1dfc7",
    [WeaponType.Guardian]: "4ade7faa-4cf1-8376-95ef-39884480959b",
    [WeaponType.Marshal]: "c4883e50-4494-202c-3ec3-6b8a9284f00b",
    [WeaponType.Outlaw]: "5f0aaf7a-4289-3998-d5ff-eb9a5cf7ef5c",
    [WeaponType.Spectre]: "462080d1-4035-2937-7c09-27aa2a5c27a7",
    [WeaponType.Stinger]: "f7e1b454-4ad4-1063-ec0a-159e56b58941",
    [WeaponType.Knife]: "2f59173c-4bed-b6c3-2191-dea9b58be9c7",
}

export const itemTypes = {
    SKIN: "e7c63390-eda7-46e0-bb7a-a6abdacd2433",
    BUDDY: "dd3bf334-87f3-40bd-b043-682a57a8dc3a",
    SPRAY: "d5f120f8-ff8c-4aac-92ea-f2b5acbe9475",
    CARD: "3f296c07-64c3-494c-923b-fe692a4fa1bd",
    TITLE: "de7caa6b-adf7-4588-bbd1-143831e786c6"
}

// example riotVersionData: {
//     "manifestId": "C330A20409C5FDF2",
//     "branch": "release-08.09",
//     "version": "08.09.00.2521387",
//     "buildVersion": "57",
//     "engineVersion": "4.27.2.0",
//     "riotClientVersion": "release-08.09-shipping-57-2521387",
//     "riotClientBuild": "86.0.3.1523.3366",
//     "buildDate": "2024-05-13T00:00:00Z"
// }
let riotVersionData = null;

export const getRiotVersionData = () => {
    if (riotVersionData === null) {
        throw "Tried to get Riot version data before it was loaded! Might be a race condition.";
    }

    return riotVersionData;
}

export const setRiotVersionData = (data) => {
    riotVersionData = data;
    cachedRiotHeaders = null; // invalidate cached headers
}

export const fetchRiotVersionData = async () => {
    console.log("Fetching latest Valorant version number...");

    const req = await fetch("https://valorant-api.com/v1/version");
    if (req.statusCode !== 200) {
        console.log(`Riot version data status code is ${req.statusCode}!`);
        console.log(req);

        return null;
    }

    const json = JSON.parse(req.body);
    riotVersionData = json.data;
    cachedRiotHeaders = null; // invalidate cached headers

    return riotVersionData;
}

// TODO: find out what how to automatically get the latest one of these
const platformOsVersion = "10.0.19042.1.256.64bit";

// Pre-compute the static X-Riot-ClientPlatform value (never changes at runtime)
const clientPlatformBase64 = (() => {
    const clientPlatformData = {
        platformType: "PC",
        platformOS: "Windows",
        platformOSVersion: platformOsVersion,
        platformChipset: "Unknown",
    };
    const json = JSON.stringify(clientPlatformData, null, "\t");
    return Buffer.from(json.replace(/\n/g, "\r\n")).toString("base64");
})();

// Cached headers object — invalidated when riotVersionData changes
let cachedRiotHeaders = null;

export const riotClientHeaders = () => {
    if (cachedRiotHeaders) return cachedRiotHeaders;

    // Get version data, with fallback if not yet loaded
    let clientVersion = "release-09.00-shipping-0-0000000"; // fallback version
    try {
        const versionData = getRiotVersionData();
        if (versionData && versionData.riotClientVersion) {
            clientVersion = versionData.riotClientVersion;
        }
    } catch (e) {
        console.warn("Version data not yet loaded, using fallback version for headers");
        // Don't cache when using fallback — we'll recompute once version loads
        return {
            "X-Riot-ClientPlatform": clientPlatformBase64,
            "X-Riot-ClientVersion": clientVersion,
        };
    }

    cachedRiotHeaders = {
        "X-Riot-ClientPlatform": clientPlatformBase64,
        "X-Riot-ClientVersion": clientVersion,
    };
    return cachedRiotHeaders;
}

export const parseSetCookie = (setCookie) => {
    if (!setCookie) {
        console.error("Riot didn't return any cookies during the auth request! Cloudflare might have something to do with it...");
        return {};
    }

    const cookies = {};
    for (const cookie of setCookie) {
        const sep = cookie.indexOf("=");
        cookies[cookie.slice(0, sep)] = cookie.slice(sep + 1, cookie.indexOf(';'));
    }
    return cookies;
}

export const stringifyCookies = (cookies) => {
    const cookieList = [];
    for (let [key, value] of Object.entries(cookies)) {
        cookieList.push(key + "=" + value);
    }
    return cookieList.join("; ");
}

export const extractTokensFromUri = (uri) => {
    // thx hamper for regex
    const match = uri.match(/access_token=((?:[a-zA-Z]|\d|\.|-|_)*).*id_token=((?:[a-zA-Z]|\d|\.|-|_)*).*expires_in=(\d*)/);
    if (!match) return [null, null];

    const [, accessToken, idToken] = match;
    return [accessToken, idToken]
}

const tokenCache = new Map();
const MAX_TOKEN_CACHE_SIZE = 256;

export const decodeToken = (token) => {
    const cached = tokenCache.get(token);
    if (cached) return cached;

    const encodedPayload = token.split('.')[1];
    const decoded = JSON.parse(atob(encodedPayload));

    if (tokenCache.size >= MAX_TOKEN_CACHE_SIZE) tokenCache.clear();
    tokenCache.set(token, decoded);

    return decoded;
}

export const tokenExpiry = (token) => {
    return decodeToken(token).exp * 1000;
}

export const userRegion = ({ region }) => {
    if (!region || region === "latam" || region === "br") return "na";
    return region;
}

export const isMaintenance = (json) => {
    return json.httpStatus === 403 && json.errorCode === "SCHEDULED_DOWNTIME";
}

export const formatBundle = async (rawBundle) => {
    const bundle = {
        uuid: rawBundle.DataAssetID,
        expires: Math.floor(Date.now() / 1000) + rawBundle.DurationRemainingInSeconds,
        items: []
    }

    let price = 0;
    let basePrice = 0;
    for (const rawItem of rawBundle.Items) {
        const item = {
            uuid: rawItem.Item.ItemID,
            type: rawItem.Item.ItemTypeID,
            item: await getItem(rawItem.Item.ItemID, rawItem.Item.ItemTypeID),
            amount: rawItem.Item.Amount,
            price: rawItem.DiscountedPrice,
            basePrice: rawItem.BasePrice,
            discount: rawItem.DiscountPercent
        }

        price += item.price;
        basePrice += item.basePrice;

        bundle.items.push(item);
    }

    bundle.price = price;
    bundle.basePrice = basePrice;

    return bundle;
}

export const fetchMaintenances = async (region) => {
    const req = await fetch(`https://valorant.secure.dyn.riotcdn.net/channels/public/x/status/${region}.json`);
    return JSON.parse(req.body);
}

export const formatNightMarket = (rawNightMarket) => {
    if (!rawNightMarket) return null;

    return {
        offers: rawNightMarket.BonusStoreOffers.map(offer => {
            return {
                uuid: offer.Offer.OfferID,
                realPrice: offer.Offer.Cost["85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741"],
                nmPrice: offer.DiscountCosts["85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741"],
                percent: offer.DiscountPercent
            }
        }),
        expires: Math.floor(Date.now() / 1000) + rawNightMarket.BonusStoreRemainingDurationInSeconds
    }
}

export const removeDupeAlerts = (alerts) => {
    const uuids = [];
    return alerts.filter(alert => {
        if (uuids.includes(alert.uuid)) return false;
        return uuids.push(alert.uuid);
    });
}

export const getPuuid = (id, account = null) => {
    const user = getUser(id, account);
    if (!user) return null;
    return user.puuid;
}

export const isDefaultSkin = (skin) => skin.skinUuid === skin.defaultSkinUuid;

// discord utils

export const defer = async (interaction, ephemeral = false) => {
    // discord only sets deferred to true once the event is sent over ws, which doesn't happen immediately
    await interaction.deferReply({ flags: ephemeral ? [MessageFlags.Ephemeral] : [] });
    interaction.deferred = true;
}

export const skinNameAndEmoji = async (skin, channel, localeOrInteraction = DEFAULT_LANG) => {
    const name = l(skin.names, localeOrInteraction);
    if (!skin.rarity) return name;

    const rarity = await getRarity(skin.rarity, channel);
    if (!rarity) return name;

    const rarityIcon = await rarityEmoji(channel, rarity.name, rarity.icon);
    return rarityIcon ? `${rarityIcon} ${name}` : name;
}

export const actionRow = (button) => new ActionRowBuilder().addComponents(button);

export const removeAlertButton = (id, uuid, buttonText) => new ButtonBuilder().setCustomId(`removealert/${uuid}/${id}/${Math.round(Math.random() * 100000)}`).setStyle(ButtonStyle.Danger).setLabel(buttonText).setEmoji("✖");
export const removeAlertActionRow = (id, uuid, buttonText) => new ActionRowBuilder().addComponents(removeAlertButton(id, uuid, buttonText));

export const canCreateEmojis = (guild) => guild && guild.members.me && (
    guild.members.me.permissions.has(PermissionsBitField.Flags.ManageEmojisAndStickers) ||
    guild.members.me.permissions.has(PermissionsBitField.Flags.CreateGuildExpressions)
);
export const emojiToString = (emoji) => emoji && `<:${emoji.name}:${emoji.id}>`;

export const canSendMessages = (channel) => {
    if (!channel || !channel.guild) return true;
    const permissions = channel.permissionsFor(channel.guild.members.me);
    return permissions.has(PermissionsBitField.Flags.ViewChannel) && permissions.has(PermissionsBitField.Flags.SendMessages) && permissions.has(PermissionsBitField.Flags.EmbedLinks);
}

export const fetchChannel = async (channelId) => {
    try {
        return await client.channels.fetch(channelId);
    } catch (e) {
        return null;
    }
}

export const getChannelGuildId = async (channelId) => {
    const cached = channelGuildCache.get(channelId);
    if (cached && Date.now() - cached.at < CHANNEL_GUILD_CACHE_TTL_MS) return cached.guildId;

    let guildId;
    const f = client => {
        const channel = client.channels.cache.get(channelId);
        if (channel) return channel.guildId;
    };
    const results = await client.shard.broadcastEval(f);
    guildId = results.find(result => result);

    if (guildId) channelGuildCache.set(channelId, { guildId, at: Date.now() });
    return guildId;
}

export const canEditInteraction = (interaction) => Date.now() - interaction.createdTimestamp < 14.8 * 60 * 1000;

export const discordTag = id => {
    const user = client.users.cache.get(id);
    return user ? `${user.username}#${user.discriminator}` : id;
}

// misc utils

export const wait = ms => new Promise(r => setTimeout(r, ms));

export const promiseTimeout = async (promise, ms, valueIfTimeout = null) => {
    return await Promise.race([promise, wait(ms).then(() => valueIfTimeout)]);
}

export const isToday = (timestamp) => isSameDay(timestamp, Date.now());
export const isSameDay = (t1, t2) => {
    t1 = new Date(t1); t2 = new Date(t2);
    return t1.getUTCFullYear() === t2.getUTCFullYear() && t1.getUTCMonth() === t2.getUTCMonth() && t1.getUTCDate() === t2.getUTCDate();
}

export const findKeyOfValue = (obj, value) => Object.keys(obj).find(key => obj[key] === value);

export const calcLength = (any) => {
    if (!isNaN(any)) any = any.toString();
    return any.length;
}

export const ordinalSuffix = (number) => number % 100 >= 11 && number % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][(number % 10 < 4) ? number % 10 : 0];