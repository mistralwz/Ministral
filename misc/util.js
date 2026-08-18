import https from "https";
import fs from "fs";
import config from "./config.js";

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
];

// Persistent keep-alive agents per hostname
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

export const fetch = (url, options = {}) => {
    if (config.logUrls) console.log("Fetching url " + url.substring(0, 200) + (url.length > 200 ? "..." : ""));

    return new Promise((resolve, reject) => {
        const hostname = new URL(url).hostname;
        const req = https.request(url, {
            agent: getKeepAliveAgent(hostname),
            method: options.method || "GET",
            headers: {
                cookie: "dummy=cookie",
                "Accept-Language": "en-US,en;q=0.5",
                "referer": "https://github.com/giorgi-o/SkinPeek",
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
                console.error("HTTP stream error:", err);
                reject(err);
            });
        });
        req.write(options.body || "");
        req.end();
        req.on('error', err => {
            console.error("HTTP request error:", err);
            reject(err);
        });
    });
};

export const fetchJson = async (url, options = {}) => {
    const res = await fetch(url, options);
    return JSON.parse(res.body);
};

export const WeaponTypeUuid = {
    Odin: "63e6c2b6-4a8e-869c-3d4c-e38355226584",
    Ares: "55d8a0f4-4274-ca67-fe2c-06ab45efdf58",
    Vandal: "9c82e19d-4575-0200-1a81-3eacf00cf872",
    Bulldog: "ae3de142-4d85-2547-dd26-4e90bed35cf7",
    Phantom: "ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a",
    Judge: "ec845bf4-4f79-ddda-a3da-0db3774b2794",
    Bucky: "910be174-449b-c412-ab22-d0873436b21b",
    Frenzy: "44d4e95c-4157-0037-81b2-17841bf2e8e3",
    Classic: "29a0cfab-485b-f5d5-779a-b59f85e204a8",
    Ghost: "1baa85b4-4c70-1284-64bb-6481dfc3bb4e",
    Sheriff: "e336c6b8-418d-9340-d77f-7a9e4cfe0702",
    Shorty: "42da8ccc-40d5-affc-beec-15aa47b42eda",
    Operator: "a03b24d3-4319-996d-0f8c-94bbfba1dfc7",
    Guardian: "4ade7faa-4cf1-8376-95ef-39884480959b",
    Marshal: "c4883e50-4494-202c-3ec3-6b8a9284f00b",
    Outlaw: "5f0aaf7a-4289-3998-d5ff-eb9a5cf7ef5c",
    Spectre: "462080d1-4035-2937-7c09-27aa2a5c27a7",
    Stinger: "f7e1b454-4ad4-1063-ec0a-159e56b58941",
    Knife: "2f59173c-4bed-b6c3-2191-dea9b58be9c7",
    Melee: "2f59173c-4bed-b6c3-2191-dea9b58be9c7"
};

export const WeaponType = Object.fromEntries(Object.entries(WeaponTypeUuid).map(([k, v]) => [v, k]));

export const itemTypes = {
    SKIN: "e7c63390-eda7-46e0-bb7a-a6abdacd2433",
    BUDDY: "dd3bf334-87f3-40bd-b043-682a57a8dc3a",
    SPRAY: "d5f120f8-ff8c-4aac-92ea-f2b5acbe9475",
    CARD: "3f296c07-64c3-494c-923b-fe692a4fa1bd",
    TITLE: "de7caa6b-adf7-4588-bbd1-143831e786c6",
    FLEX: "03a572de-4234-31ed-d344-ababa488f981"
};

export const clientPlatformBase64 = "ewogICAgInBsYXRmb3JtVHlwZSI6ICJQQyIsCiAgICAicGxhdGZvcm1PUyI6ICJXaW5kb3dzIiwKICAgICJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwKICAgICJwbGF0Zm9ybUNoaXBzZXQiOiAiVW5rbm93biIKfQ==";

let cachedRiotVersionData = null;
let cachedRiotHeaders = null;

export const setRiotVersionData = (data) => {
    cachedRiotVersionData = data;
    cachedRiotHeaders = {
        "X-Riot-ClientPlatform": clientPlatformBase64,
        "X-Riot-ClientVersion": data.riotClientVersion,
    };
};

export const getRiotVersionData = () => cachedRiotVersionData;

export const fetchRiotVersionData = async () => {
    try {
        const req = await fetch("https://valorant-api.com/v1/version");
        if (req.statusCode === 200) {
            const json = JSON.parse(req.body);
            if (json.status === 200 && json.data) {
                setRiotVersionData(json.data);
                return json.data;
            }
        }
    } catch (e) {
        console.error("Failed to fetch Riot version data from valorant-api.com:", e);
    }
    return null;
};

export const riotClientHeaders = () => {
    if (cachedRiotHeaders) return cachedRiotHeaders;

    let clientVersion = "release-10.00-shipping-0-0000000";
    if (cachedRiotVersionData && cachedRiotVersionData.riotClientVersion) {
        clientVersion = cachedRiotVersionData.riotClientVersion;
    } else {
        fetchRiotVersionData();
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
};

const tokenCache = new Map();
const MAX_TOKEN_CACHE_SIZE = 256;

export const decodeToken = (token) => {
    if (!token) return null;
    const cached = tokenCache.get(token);
    if (cached) return cached;

    try {
        const encodedPayload = token.split('.')[1];
        const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));

        if (tokenCache.size >= MAX_TOKEN_CACHE_SIZE) tokenCache.clear();
        tokenCache.set(token, decoded);

        return decoded;
    } catch (e) {
        console.error("Failed to decode JWT token:", e);
        return null;
    }
};

export const tokenExpiry = (token) => {
    const decoded = decodeToken(token);
    return decoded?.exp ? decoded.exp * 1000 : 0;
};

export const userRegion = ({ region }) => {
    if (!region || region === "latam" || region === "br") return "na";
    return region;
};

export const isMaintenance = (json) => {
    return json?.httpStatus === 403 && json?.errorCode === "SCHEDULED_DOWNTIME";
};

export const fetchMaintenances = async (region) => {
    const req = await fetch(`https://valorant.secure.dyn.riotcdn.net/channels/public/x/status/${region}.json`);
    return JSON.parse(req.body);
};

export const removeDupeAlerts = (alerts) => {
    if (!Array.isArray(alerts)) return [];
    const uuids = new Set();
    return alerts.filter(alert => {
        if (!alert || uuids.has(alert.uuid)) return false;
        uuids.add(alert.uuid);
        return true;
    });
};

export const isDefaultSkin = (skin) => skin.skinUuid === skin.defaultSkinUuid;

// Pure utility helpers

export const wait = (ms) => new Promise(r => setTimeout(r, ms));

export const isToday = (timestamp) => isSameDay(timestamp, Date.now());

export const isSameDay = (t1, t2) => {
    const d1 = new Date(t1);
    const d2 = new Date(t2);
    return d1.getUTCFullYear() === d2.getUTCFullYear() &&
        d1.getUTCMonth() === d2.getUTCMonth() &&
        d1.getUTCDate() === d2.getUTCDate();
};

export const ordinalSuffix = (number) => {
    return number % 100 >= 11 && number % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][(number % 10 < 4) ? number % 10 : 0];
};