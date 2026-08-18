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
    "Odin": "63e6c2b6-4a8e-869c-3d4c-e38355226584",
    "Ares": "55d8a0f4-4274-ca67-b77f-64eed50c59c7",
    "Vandal": "9c82e148-4036-4cce-9f9c-c46d96738b73",
    "Bulldog": "ae3de142-4ee9-5713-a5d2-b2eb8240ec9f",
    "Phantom": "ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a",
    "Judge": "ec84293c-47e1-ab56-8579-73809f78cde5",
    "Bucky": "910ae148-46d1-42e0-ab44-16923439740c",
    "Frenzy": "44d4e95c-4157-0037-81b2-17841bf2e8e3",
    "Classic": "29a0cfab-485b-f5d5-779a-b59f85e204a8",
    "Ghost": "1baa85b4-4c70-1774-8839-7776f8e5c150",
    "Sheriff": "e3367522-4976-d689-04a4-2382ce37f9d9",
    "Shorty": "42da8cee-42fc-2d61-c67b-35b443a4232c",
    "Operator": "a03b24d3-4319-996d-0f8c-94eac02437d3",
    "Guardian": "4ade7faa-4cf1-8372-4c3d-e28043699470",
    "Marshal": "c4883e50-4494-202c-be36-44c502542cd6",
    "Spectre": "469f4044-4922-44d4-b074-60da56b632f2",
    "Stinger": "f7e1b453-434e-51da-b718-16e2605c703f",
    "Melee": "2f59173c-4bed-b6c3-2191-dea9b58be9c7",
    "Outlaw": "5f0aaf3a-4b3d-9c4c-4fe7-3c9702a52b94"
};

export const WeaponType = Object.fromEntries(Object.entries(WeaponTypeUuid).map(([k, v]) => [v, k]));

export const itemTypes = {
    SKIN: "e7c63390-eda7-46e0-bb7a-a6abdacd2433",
    BUDDY: "dd3bf334-87f3-40bd-b043-682a57a8dc3a",
    SPRAY: "d5f120f8-ff8c-4aac-92ea-f2b5acbe9479",
    CARD: "3f296c07-64c3-494c-923b-fe692a4e1022",
    TITLE: "de7cf6a8-4c15-49dda24d-4d033b03baf8",
    FLEX: "5f8a0026-4cec-1f06-8d82-388276f75608"
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