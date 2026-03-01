/**
 * Live Game Module — pre-game and in-game match viewer
 *
 * Endpoints used (all require user's RSO + entitlement token):
 *   GLZ pregame:  GET  glz-{shard}-1.{region}.a.pvp.net/pregame/v1/players/{puuid}
 *                 GET  glz-{shard}-1.{region}.a.pvp.net/pregame/v1/matches/{matchId}
 *   GLZ coregame: GET  glz-{shard}-1.{region}.a.pvp.net/core-game/v1/players/{puuid}
 *                 GET  glz-{shard}-1.{region}.a.pvp.net/core-game/v1/matches/{matchId}
 *   PD  MMR:      GET  pd.{shard}.a.pvp.net/mmr/v1/players/{targetPuuid}
 *   PD  names:    PUT  pd.{shard}.a.pvp.net/name-service/v2/players
 *   PD  levels:   GET  pd.{shard}.a.pvp.net/account-xp/v1/players/{targetPuuid}
 *   ext agents:   GET  https://valorant-api.com/v1/agents
 *   ext tiers:    GET  https://valorant-api.com/v1/competitivetiers
 */

import { fetch, riotClientHeaders, userRegion } from "../misc/util.js";
import { authUser, getUser } from "./auth.js";

// ──────────────────────────────────────────────
// Region helpers
// ──────────────────────────────────────────────

/** GLZ base URL — the shard matches userRegion() (latam/br → na); region is raw */
const glzUrl = (user) =>
    `https://glz-${user.region}-1.${userRegion(user)}.a.pvp.net`;

/** PD base URL */
const pdUrl = (user) =>
    `https://pd.${userRegion(user)}.a.pvp.net`;

/** Standard auth headers for a user object */
const authHeaders = (user) => ({
    "Authorization": `Bearer ${user.auth.rso}`,
    "X-Riot-Entitlements-JWT": user.auth.ent,
    ...riotClientHeaders(),
});

// ──────────────────────────────────────────────
// Static data caches (agents + competitive tiers)
// ──────────────────────────────────────────────

let agentsCache = null;
let competitiveTiersCache = null;
let gamemodesCache = null;

/** Fetch all playable agents once and cache them (keyed by lower-case UUID). */
const loadAgents = async () => {
    if (agentsCache) return;
    try {
        const req = await fetch("https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=all");
        const json = JSON.parse(req.body);
        agentsCache = {};
        for (const agent of json.data) {
            agentsCache[agent.uuid.toLowerCase()] = {
                names: agent.displayName, // This is an object of locale strings because of `language=all`
                icon: agent.displayIcon,
                roles: agent.role?.displayName ?? null,
                roleUuid: agent.role?.uuid ?? null,
                roleIcon: agent.role?.displayIcon ?? null,
            };
        }
    } catch (e) {
        console.error("[livegame] Failed to load agents:", e);
        agentsCache = {};   // don't retry spam on every call
    }
};

/** Fetch current-episode competitive tier data once and cache (keyed by tier number). */
const loadCompetitiveTiers = async () => {
    if (competitiveTiersCache) return;
    try {
        const req = await fetch("https://valorant-api.com/v1/competitivetiers");
        const json = JSON.parse(req.body);
        // last array entry is the latest episode
        const latest = json.data[json.data.length - 1];
        competitiveTiersCache = {};
        for (const tier of latest.tiers) {
            competitiveTiersCache[tier.tier] = {
                name: tier.tierName === "Unused"
                    ? "Unranked"
                    : tier.tierName.replaceAll("_", " "),   // e.g. "GOLD 3"
                color: "#" + (tier.color ?? "000000").slice(0, 6),
                icon: tier.largeIcon ?? tier.smallIcon ?? null,
            };
        }
    } catch (e) {
        console.error("[livegame] Failed to load competitive tiers:", e);
        competitiveTiersCache = {};
    }
};

/** Invalidate all static caches (call when skins/version reloads). */
export const clearLiveGameCache = () => {
    agentsCache = null;
    competitiveTiersCache = null;
    gamemodesCache = null;
    mapImagesCache = null;
    mapNamesCache = null;
    seasonsCache = null;
    currentSeasonId = null;
};

const loadGamemodes = async () => {
    if (gamemodesCache) return;
    try {
        const req = await globalThis.fetch("https://valorant-api.com/v1/gamemodes?language=all");
        const json = await req.json();
        gamemodesCache = {};
        for (const mode of json.data) {
            gamemodesCache[mode.uuid.toLowerCase()] = {};
            if (mode.displayName && typeof mode.displayName === "object") {
                // Populate the cache with localized strings (e.g. ['en-US': 'Swiftplay', ...])
                for (const [lang, val] of Object.entries(mode.displayName)) {
                    gamemodesCache[mode.uuid.toLowerCase()][lang] = val;
                }
            } else {
                gamemodesCache[mode.uuid.toLowerCase()]["en-US"] = mode.displayName;
            }
        }
    } catch (e) {
        console.error("[livegame] Failed to load gamemodes:", e);
        gamemodesCache = {};
    }
};

/** Resolve agent UUID → {names, icon, roles} */
export const resolveAgent = async (uuid) => {
    await loadAgents();
    return agentsCache[uuid?.toLowerCase()] ?? { names: { "en-US": "Unknown Agent" }, icon: null, roles: null };
};

/** Get all known playable agent UUIDs */
export const getAllPlayableAgents = async () => {
    await loadAgents();
    return Object.keys(agentsCache || {});
};

/** Resolve tier number (0-27) → {name, color, icon} */
export const resolveTier = async (tier) => {
    await loadCompetitiveTiers();
    return competitiveTiersCache[tier ?? 0] ?? { name: "Unranked", color: "#000000", icon: null };
};

// ──────────────────────────────────────────────
// Map ID → display name
// ──────────────────────────────────────────────

const MAP_NAMES = {
    "/Game/Maps/Ascent/Ascent": "Ascent",
    "/Game/Maps/Bonsai/Bonsai": "Split",
    "/Game/Maps/Canyon/Canyon": "Fracture",
    "/Game/Maps/Duality/Duality": "Bind",
    "/Game/Maps/Foxtrot/Foxtrot": "Breeze",
    "/Game/Maps/Port/Port": "Icebox",
    "/Game/Maps/Triad/Triad": "Haven",
    "/Game/Maps/Pitt/Pitt": "Pearl",
    "/Game/Maps/Jam/Jam": "Lotus",
    "/Game/Maps/Juliett/Juliett": "Sunset",
    "/Game/Maps/HURM/HURM_Alley/HURM_Alley": "District",
    "/Game/Maps/HURM/HURM_Bowl/HURM_Bowl": "Kasbah",
    "/Game/Maps/HURM/HURM_Helix/HURM_Helix": "Drift",
    "/Game/Maps/HURM/HURM_Yard/HURM_Yard": "Glitch",
    "/Game/Maps/Arena/Arena": "The Range",
};

export const resolveMapName = (mapId) =>
    // API displayName takes priority — covers new maps (Corrode, etc.) automatically
    (mapNamesCache && mapNamesCache[mapId])
    ?? MAP_NAMES[mapId]
    ?? (mapId?.split("/").pop() ?? "Unknown Map");

// ──────────────────────────────────────────────
// Map data cache — image + display name per mapUrl
// ──────────────────────────────────────────────

let mapImagesCache = null;
let mapNamesCache = null;  // populated alongside images

const loadMapImages = async () => {
    if (mapImagesCache) return;
    try {
        const req = await fetch("https://valorant-api.com/v1/maps");
        const json = JSON.parse(req.body);
        mapImagesCache = {};
        mapNamesCache = {};
        for (const m of json.data) {
            if (m.mapUrl) {
                // listViewIcon is the compact square thumbnail used in list
                // views — much smaller than splash or listViewIconTall.
                mapImagesCache[m.mapUrl] = m.listViewIcon ?? m.splash ?? null;
                if (m.displayName) mapNamesCache[m.mapUrl] = m.displayName;
            }
        }
    } catch (e) {
        console.error("[livegame] Failed to load map images:", e);
        mapImagesCache = {};
        mapNamesCache = {};
    }
};

export const resolveMapImage = async (mapId) => {
    await loadMapImages();
    return mapImagesCache[mapId] ?? null;
};

// ──────────────────────────────────────────────
// Seasons cache — act UUID → label ("E5A3", "V25A1", …)
// ──────────────────────────────────────────────

let seasonsCache = null;
let currentSeasonId = null;  // UUID of the currently active act (populated by loadSeasons)

/**
 * Derive a short act label from the season's assetPath.
 *   Season_Episode5_Act3_DataAsset   → "E5A3"
 *   Season_EpisodeV25-1_Act1_DataAsset → "V25A1"
 *   Season_EpisodeV26-2_Act4_DataAsset → "V26A4"
 */
const actLabelFromPath = (assetPath = "") => {
    let m = assetPath.match(/Season_Episode(\d+)_Act(\d+)/);
    if (m) return `E${m[1]}A${m[2]}`;
    m = assetPath.match(/Season_EpisodeV(\d+)-\d+_Act(\d+)/);
    if (m) return `V${m[1]}A${m[2]}`;
    return null;
};

const loadSeasons = async () => {
    if (seasonsCache) return seasonsCache;
    seasonsCache = new Map();
    try {
        const req = await fetch("https://valorant-api.com/v1/seasons");
        if (req.statusCode === 200) {
            const { data } = JSON.parse(req.body);
            const now = Date.now();
            for (const s of data) {
                if (s.type === "EAresSeasonType::Act") {
                    const label = actLabelFromPath(s.assetPath);
                    if (label) seasonsCache.set(s.uuid, label);
                    // Detect the currently active act so parseMMRData can
                    // distinguish "unranked this season" from "old season rank".
                    if (s.startTime && s.endTime) {
                        const start = new Date(s.startTime).getTime();
                        const end = new Date(s.endTime).getTime();
                        if (now >= start && now <= end) currentSeasonId = s.uuid;
                    }
                }
            }
        }
    } catch (e) {
        console.error("[livegame] loadSeasons failed:", e);
    }
    return seasonsCache;
};

const GAME_PODS = {
    "aresqa.aws-rclusterprod-use1-1.dev1-gp-ashburn-1": "Ashburn",
    "aresqa.aws-use1-dev.main1-gp-ashburn-1": "Ashburn",
    "aresriot.aws-mes1-prod.eu-gp-bahrain-1": "Bahrain",
    "aresriot.aws-mes1-prod.ext1-gp-bahrain-1": "Bahrain",
    "aresriot.aws-mes1-prod.ext2-gp-bahrain-1": "Bahrain",
    "aresriot.aws-mes1-prod.tournament-gp-bahrain-1": "Bahrain",
    "aresriot.aws-rclusterprod-mes1-1.eu-gp-bahrain-awsedge-1": "Bahrain",
    "aresriot.aws-rclusterprod-mes1-1.ext1-gp-bahrain-awsedge-1": "Bahrain",
    "aresriot.aws-rclusterprod-mes1-1.tournament-gp-bahrain-awsedge-1": "Bahrain",
    "loltencent.qcloud.val-gp-beijing-1": "Beijing",
    "aresriot.aws-bog1-prod.latam-gp-bogota-1": "Bogotá",
    "aresriot.aws-bog1-prod.tournament-gp-bogota-1": "Bogotá",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-cmob-1": "CMOB 1",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-cmob-2": "CMOB 2",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-cmob-3": "CMOB 3",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-cmob-4": "CMOB 4",
    "aresriot.aws-afs1-prod.eu-gp-capetown-1": "Cape Town",
    "aresriot.aws-afs1-prod.ext1-gp-capetown-1": "Cape Town",
    "aresriot.aws-afs1-prod.tournament-gp-capetown-1": "Cape Town",
    "aresriot.aws-chi1-prod.ext1-gp-chicago-1": "Chicago",
    "aresriot.aws-chi1-prod.ext2-gp-chicago-1": "Chicago",
    "aresriot.aws-chi1-prod.latam-gp-chicago-1": "Chicago",
    "aresriot.aws-ord1-prod.ext1-gp-chicago-1": "Chicago",
    "aresriot.aws-ord1-prod.latam-gp-chicago-1": "Chicago",
    "aresriot.mtl-riot-ord2-3.ext1-gp-chicago-1": "Chicago",
    "aresriot.mtl-riot-ord2-3.latam-gp-chicago-1": "Chicago",
    "loltencent.qcloud.val-gp-chongqing-1": "Chongqing",
    "arestencent.qcloud-cq1.alpha1-gp-1": "Chongqing 1",
    "arestencent.qcloud-cq1.alpha1-gp-3": "Chongqing 1",
    "arestencent.qcloud-cq1.alpha1-gp-2": "Chongqing 2",
    "arestencent.qcloud-cq1.alpha1-gp-4": "Chongqing 2",
    "arestencent.qcloud-cq1.alpha1-gp-5": "Chongqing 5",
    "arestencent.qcloud-cq1.alpha1-gp-6": "Chongqing 6",
    "arestencent.qcloud-cq1.alpha1-gp-7": "Chongqing 7",
    "arestencent.qcloud-cq1.alpha1-gp-8": "Chongqing 8",
    "aresqa.aws-dfw1-dev.main1-gp-dallas-1": "Dallas",
    "aresqa.aws-rclusterprod-dfw1-1.dev1-gp-dallas-1": "Dallas",
    "aresriot.aws-dfw1-dev.main-gp-dallas-1": "Dallas",
    "aresriot.aws-mec1-prod.eu-gp-dubai-1": "Dubai",
    "aresriot.aws-mec1-prod.tournament-gp-dubai-1": "Dubai",
    "arespreprod.aws-euc1-prod.stage-release-1-gp-frankfurt-1": "Frankfurt",
    "arespreprod.aws-euc1-prod.stage2-gp-frankfurt-1": "Frankfurt",
    "aresqa.aws-euc1-dev.main1-gp-frankfurt-1": "Frankfurt",
    "aresqa.aws-euc1-dev.stage1-gp-frankfurt-1": "Frankfurt",
    "aresqa.aws-rclusterprod-euc1-1.dev1-gp-frankfurt-1": "Frankfurt",
    "aresqa.aws-rclusterprod-euc1-1.stage1-gp-frankfurt-1": "Frankfurt",
    "aresriot.aws-euc1-prod.eu-gp-frankfurt-1": "Frankfurt",
    "aresriot.aws-euc1-prod.ext1-gp-eu1": "Frankfurt",
    "aresriot.aws-euc1-prod.ext1-gp-frankfurt-1": "Frankfurt",
    "aresriot.aws-euc1-prod.ext2-gp-frankfurt-1": "Frankfurt",
    "aresriot.aws-euc1-prod.tournament-gp-frankfurt-1": "Frankfurt",
    "aresriot.aws-rclusterprod-euc1-1.ext1-gp-eu1": "Frankfurt",
    "aresriot.aws-rclusterprod-euc1-1.tournament-gp-frankfurt-1": "Frankfurt",
    "aresriot.aws-rclusterprod-euc1-1.eu-gp-frankfurt-1": "Frankfurt 1",
    "aresriot.aws-rclusterprod-euc1-1.eu-gp-frankfurt-awsedge-1": "Frankfurt 2",
    "aresqa.aws-atl1-dev.main1-gp-atlanta-1": "Georgia",
    "loltencent.qcloud.val-gp-guangzhou-1": "Guangzhou",
    "arestencent.qcloud-gz1.alpha1-gp-1": "Guangzhou 1",
    "arestencent.qcloud-gz1.alpha1-gp-3": "Guangzhou 1",
    "arestencent.qcloud-gz1.alpha1-gp-2": "Guangzhou 2",
    "arestencent.qcloud-gz1.alpha1-gp-4": "Guangzhou 2",
    "arestencent.qcloud-gz1.alpha1-gp-5": "Guangzhou 5",
    "arestencent.qcloud-gz1.alpha1-gp-6": "Guangzhou 6",
    "arestencent.qcloud-gz1.alpha1-gp-7": "Guangzhou 7",
    "arestencent.qcloud-gz1.alpha1-gp-8": "Guangzhou 8",
    "aresriot.aws-ape1-prod.ap-gp-hongkong-1": "Hong Kong",
    "aresriot.aws-ape1-prod.ext1-gp-hongkong-1": "Hong Kong",
    "aresriot.aws-ape1-prod.ext2-gp-hongkong-1": "Hong Kong",
    "aresriot.aws-ape1-prod.tournament-gp-hongkong-1": "Hong Kong",
    "aresriot.aws-rclusterprod-ape1-1.ext1-gp-hongkong-1": "Hong Kong",
    "aresriot.aws-rclusterprod-ape1-1.tournament-gp-hongkong-1": "Hong Kong",
    "aresriot.aws-rclusterprod-ape1-1.ap-gp-hongkong-1": "Hong Kong 1",
    "aresriot.aws-rclusterprod-ape1-1.ap-gp-hongkong-awsedge-1": "Hong Kong 2",
    "aresriot.aws-ist1-prod.eu-gp-istanbul-1": "Istanbul",
    "aresriot.aws-ist1-prod.tournament-gp-istanbul-1": "Istanbul",
    "aresriot.mtl-riot-ist1-2.eu-gp-istanbul-2": "Istanbul",
    "aresriot.mtl-riot-ist1-2.tournament-gp-istanbul-1": "Istanbul",
    "aresriot.mtl-riot-ist1-2.tournament-gp-istanbul-2": "Istanbul",
    "aresriot.mtl-riot-ist1-2.eu-gp-istanbul-1": "Istanbul 2",
    "arespreprod.aws-euw2-prod.cert-gp-london-1": "London",
    "aresriot.aws-euw2-prod.eu-gp-london-1": "London",
    "aresriot.aws-euw2-prod.tournament-gp-london-1": "London",
    "aresriot.aws-rclusterprod-euw2-1.eu-gp-london-awsedge-1": "London",
    "aresriot.aws-rclusterprod-euw2-1.tournament-gp-london-awsedge-1": "London",
    "aresriot.aws-eus2-prod.eu-gp-madrid-1": "Madrid",
    "aresriot.aws-eus2-prod.tournament-gp-madrid-1": "Madrid",
    "aresriot.aws-rclusterprod-mad1-1.eu-gp-madrid-1": "Madrid",
    "aresriot.aws-rclusterprod-mad1-1.tournament-gp-madrid-1": "Madrid",
    "aresriot.aws-qro1-prod.ext1-gp-mexico-1": "Mexico City",
    "aresriot.aws-qro1-prod.ext2-gp-mexico-1": "Mexico City",
    "aresriot.aws-qro1-prod.latam-gp-mexico-1": "Mexico City",
    "aresriot.aws-qro1-prod.tournament-gp-mexico-1": "Mexico City",
    "aresriot.mtl-tmx-mex1-1.ext1-gp-mexicocity-1": "Mexico City",
    "aresriot.mtl-tmx-mex1-1.latam-gp-mexicocity-1": "Mexico City",
    "aresriot.mtl-tmx-mex1-1.tournament-gp-mexicocity-1": "Mexico City",
    "aresriot.aws-mia1-prod.latam-gp-miami-1": "Miami",
    "aresriot.aws-mia1-prod.tournament-gp-miami-1": "Miami",
    "aresriot.aws-mia2-prod.latam-gp-miami-2": "Miami",
    "aresriot.mia1.latam-gp-miami-1": "Miami",
    "aresriot.mia1.tournament-gp-miami-1": "Miami",
    "aresriot.aws-aps1-prod.ap-gp-mumbai-1": "Mumbai",
    "aresriot.aws-aps1-prod.tournament-gp-mumbai-1": "Mumbai",
    "aresriot.aws-rclusterprod-aps1-1.ap-gp-mumbai-awsedge-1": "Mumbai",
    "aresriot.aws-rclusterprod-aps1-1.tournament-gp-mumbai-awsedge-1": "Mumbai",
    "aresqa.aws-rclusterprod-usw1-1.dev1-gp-1": "N. California",
    "aresqa.aws-usw1-dev.main1-gp-norcal-1": "N. California",
    "arestencentqa.qcloud-nj1.stage1-gp-1": "Nanjing",
    "arestencent.qcloud-nj1.alpha1-gp-1": "Nanjing 1",
    "arestencent.qcloud-nj1.alpha1-gp-2": "Nanjing 2",
    "arestencent.qcloud-nj1.alpha1-gp-4": "Nanjing 2",
    "arestencent.qcloud-nj1.alpha1-gp-5": "Nanjing 5",
    "arestencent.qcloud-nj1.alpha1-gp-6": "Nanjing 6",
    "arestencent.qcloud-nj1.alpha1-gp-7": "Nanjing 7",
    "arestencent.qcloud-nj1.alpha1-gp-8": "Nanjing 8",
    "arestencentqa.qcloud-nj1.loadtest1-gp-2": "Nanjing Loadtest 2",
    "arestencent.qcloud-nj1.alpha1-gp-3": "Nanjing Multi ISP",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-offline-1": "Offline 1",
    "aresriot.aws-usw2-prod.tournament-gp-offline-1": "Offline 1",
    "aresriot.aws-usw2-prod.tournament-gp-offline-10": "Offline 10",
    "aresriot.aws-usw2-prod.tournament-gp-offline-11": "Offline 11",
    "aresriot.aws-usw2-prod.tournament-gp-offline-12": "Offline 12",
    "aresriot.aws-usw2-prod.tournament-gp-offline-13": "Offline 13",
    "aresriot.aws-usw2-prod.tournament-gp-offline-14": "Offline 14",
    "aresriot.aws-usw2-prod.tournament-gp-offline-15": "Offline 15",
    "aresriot.aws-usw2-prod.tournament-gp-offline-16": "Offline 16",
    "aresriot.aws-usw2-prod.tournament-gp-offline-17": "Offline 17",
    "aresriot.aws-usw2-prod.tournament-gp-offline-18": "Offline 18",
    "aresriot.aws-usw2-prod.tournament-gp-offline-19": "Offline 19",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-offline-2": "Offline 2",
    "aresriot.aws-usw2-prod.tournament-gp-offline-2": "Offline 2",
    "aresriot.aws-usw2-prod.tournament-gp-offline-20": "Offline 20",
    "aresriot.aws-usw2-prod.tournament-gp-offline-21": "Offline 21",
    "aresriot.aws-usw2-prod.tournament-gp-offline-22": "Offline 22",
    "aresriot.aws-usw2-prod.tournament-gp-offline-23": "Offline 23",
    "aresriot.aws-usw2-prod.tournament-gp-offline-24": "Offline 24",
    "aresriot.aws-usw2-prod.tournament-gp-offline-25": "Offline 25",
    "aresriot.aws-usw2-prod.tournament-gp-offline-26": "Offline 26",
    "aresriot.aws-usw2-prod.tournament-gp-offline-27": "Offline 27",
    "aresriot.aws-usw2-prod.tournament-gp-offline-28": "Offline 28",
    "aresriot.aws-usw2-prod.tournament-gp-offline-29": "Offline 29",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-offline-3": "Offline 3",
    "aresriot.aws-usw2-prod.tournament-gp-offline-3": "Offline 3",
    "aresriot.aws-usw2-prod.tournament-gp-offline-30": "Offline 30",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-offline-4": "Offline 4",
    "aresriot.aws-usw2-prod.tournament-gp-offline-4": "Offline 4",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-offline-5": "Offline 5",
    "aresriot.aws-usw2-prod.tournament-gp-offline-5": "Offline 5",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-offline-6": "Offline 6",
    "aresriot.aws-usw2-prod.tournament-gp-offline-6": "Offline 6",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-offline-7": "Offline 7",
    "aresriot.aws-usw2-prod.tournament-gp-offline-7": "Offline 7",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-offline-8": "Offline 8",
    "aresriot.aws-usw2-prod.tournament-gp-offline-8": "Offline 8",
    "aresriot.aws-usw2-prod.tournament-gp-offline-9": "Offline 9",
    "aresriot.aws-euw3-prod.eu-gp-paris-1": "Paris",
    "aresriot.aws-euw3-prod.tournament-gp-paris-1": "Paris",
    "aresriot.aws-rclusterprod-euw3-1.tournament-gp-paris-1": "Paris",
    "aresriot.aws-rclusterprod-euw3-1.eu-gp-paris-1": "Paris 1",
    "aresriot.aws-rclusterprod-euw3-1.eu-gp-paris-awsedge-1": "Paris 2",
    "globaltencent.tcc-tcloudtest-sjc1-1.val-gp-1": "SJC",
    "aresriot.aws-scl1-prod.ext1-gp-santiago-1": "Santiago",
    "aresriot.aws-scl1-prod.ext2-gp-santiago-1": "Santiago",
    "aresriot.aws-scl1-prod.latam-gp-santiago-1": "Santiago",
    "aresriot.aws-scl1-prod.tournament-gp-santiago-1": "Santiago",
    "aresriot.mtl-ctl-scl2-2.ext1-gp-santiago-1": "Santiago",
    "aresriot.mtl-ctl-scl2-2.latam-gp-santiago-1": "Santiago",
    "aresriot.mtl-ctl-scl2-2.tournament-gp-santiago-1": "Santiago",
    "aresriot.aws-rclusterprod-sae1-1.ext1-gp-saopaulo-1": "Sao Paulo",
    "aresriot.aws-rclusterprod-sae1-1.tournament-gp-saopaulo-1": "Sao Paulo",
    "aresriot.aws-sae1-prod.br-gp-saopaulo-1": "Sao Paulo",
    "aresriot.aws-sae1-prod.ext1-gp-saopaulo-1": "Sao Paulo",
    "aresriot.aws-sae1-prod.ext2-gp-saopaulo-1": "Sao Paulo",
    "aresriot.aws-sae1-prod.tournament-gp-saopaulo-1": "Sao Paulo",
    "aresriot.aws-rclusterprod-sae1-1.br-gp-saopaulo-1": "Sao Paulo 1",
    "aresriot.aws-rclusterprod-sae1-1.br-gp-saopaulo-awsedge-1": "Sao Paulo 2",
    "arespreprod.aws-apne2-prod.cert-gp-seoul-1": "Seoul",
    "aresriot.aws-apne2-prod.ext1-gp-seoul-1": "Seoul",
    "aresriot.aws-apne2-prod.ext2-gp-seoul-1": "Seoul",
    "aresriot.aws-apne2-prod.kr-gp-seoul-1": "Seoul",
    "aresriot.aws-apne2-prod.tournament-gp-seoul-1": "Seoul",
    "aresriot.aws-rclusterprod-apne2-1.ext1-gp-seoul-1": "Seoul",
    "aresriot.aws-rclusterprod-apne2-1.tournament-gp-seoul-1": "Seoul",
    "aresriot.aws-rclusterprod-apne2-1.kr-gp-seoul-1": "Seoul 1",
    "loltencent.qcloud.val-gp-shanghai-1": "Shanghai",
    "aresqa.aws-apse1-dev.main1-gp-singapore-1": "Singapore",
    "aresriot.aws-apse1-prod.ap-gp-singapore-1": "Singapore",
    "aresriot.aws-apse1-prod.ext1-gp-singapore-1": "Singapore",
    "aresriot.aws-apse1-prod.ext2-gp-singapore-1": "Singapore",
    "aresriot.aws-apse1-prod.tournament-gp-singapore-1": "Singapore",
    "aresriot.aws-rclusterprod-apse1-1.ext1-gp-singapore-1": "Singapore",
    "aresriot.aws-rclusterprod-apse1-1.tournament-gp-singapore-1": "Singapore",
    "aresriot.aws-rclusterprod-apse1-1.ap-gp-singapore-1": "Singapore 1",
    "aresriot.aws-rclusterprod-apse1-1.ap-gp-singapore-awsedge-1": "Singapore 2",
    "aresriot.aws-eun1-prod.eu-gp-stockholm-1": "Stockholm",
    "aresriot.aws-eun1-prod.tournament-gp-stockholm-1": "Stockholm",
    "aresriot.aws-rclusterprod-eun1-1.tournament-gp-stockholm-1": "Stockholm",
    "aresriot.aws-rclusterprod-eun1-1.eu-gp-stockholm-1": "Stockholm 1",
    "aresriot.aws-rclusterprod-eun1-1.eu-gp-stockholm-awsedge-1": "Stockholm 2",
    "arespreprod.aws-apse2-prod.cert-gp-sydney-1": "Sydney",
    "arespreprod.aws-apse2-prod.stage-release-1-gp-sydney-1": "Sydney",
    "arespreprod.aws-apse2-prod.stage2-gp-sydney-1": "Sydney",
    "aresqa.aws-apse2-dev.main1-gp-sydney-1": "Sydney",
    "aresqa.aws-apse2-dev.stage1-gp-sydney-1": "Sydney",
    "aresriot.aws-apse2-prod.ap-gp-sydney-1": "Sydney",
    "aresriot.aws-apse2-prod.ext1-gp-sydney-1": "Sydney",
    "aresriot.aws-apse2-prod.ext2-gp-sydney-1": "Sydney",
    "aresriot.aws-apse2-prod.tournament-gp-sydney-1": "Sydney",
    "aresriot.aws-rclusterprod-apse2-1.ext1-gp-sydney-1": "Sydney",
    "aresriot.aws-rclusterprod-apse2-1.tournament-gp-sydney-1": "Sydney",
    "aresriot.aws-rclusterprod-apse2-1.ap-gp-sydney-1": "Sydney 1",
    "aresriot.aws-rclusterprod-apse2-1.ap-gp-sydney-awsedge-1": "Sydney 2",
    "arestencentqa.qcloud-tj1.stage1-gp-1": "Tianjin",
    "arestencent.qcloud-tj1.alpha1-gp-1": "Tianjin 1",
    "arestencent.qcloud-tj1.alpha1-gp-3": "Tianjin 1",
    "arestencent.qcloud-tj1.alpha1-gp-2": "Tianjin 2",
    "arestencent.qcloud-tj1.alpha1-gp-4": "Tianjin 2",
    "arestencent.qcloud-tj1.alpha1-gp-5": "Tianjin 5",
    "arestencent.qcloud-tj1.alpha1-gp-6": "Tianjin 6",
    "arestencent.qcloud-tj1.alpha1-gp-7": "Tianjin 7",
    "arestencent.qcloud-tj1.alpha1-gp-8": "Tianjin 8",
    "aresriot.aws-apne1-prod.ap-gp-tokyo-1": "Tokyo",
    "aresriot.aws-apne1-prod.eu-gp-tokyo-1": "Tokyo",
    "aresriot.aws-apne1-prod.ext1-gp-kr1": "Tokyo",
    "aresriot.aws-apne1-prod.ext1-gp-tokyo-1": "Tokyo",
    "aresriot.aws-apne1-prod.pbe-gp-tokyo-1": "Tokyo",
    "aresriot.aws-apne1-prod.tournament-gp-tokyo-1": "Tokyo",
    "aresriot.aws-mnl1-prod.ap-gp-manila-1": "Manila",
    "aresriot.aws-rclusterprod-apne1-1.eu-gp-tokyo-1": "Tokyo",
    "aresriot.aws-rclusterprod-apne1-1.ext1-gp-kr1": "Tokyo",
    "aresriot.aws-rclusterprod-apne1-1.tournament-gp-tokyo-1": "Tokyo",
    "aresriot.aws-rclusterprod-apne1-1.ap-gp-tokyo-1": "Tokyo 1",
    "aresriot.aws-rclusterprod-apne1-1.ap-gp-tokyo-awsedge-1": "Tokyo 2",
    "aresqa.aws-usw2-dev.main1-gp-tournament-2": "Tournament",
    "aresriot.aws-rclusterprod-atl1-1.na-gp-atlanta-1": "US East (Atlanta 1)",
    "aresriot.aws-atl1-prod.na-gp-atlanta-1": "US Central (Georgia)",
    "aresriot.aws-atl1-prod.tournament-gp-atlanta-1": "US Central (Georgia)",
    "aresriot.aws-atl2-prod.na-gp-atlanta-2": "US Central (Georgia)",
    "aresriot.aws-rclusterprod-atl1-1.tournament-gp-atlanta-1":
        "US Central (Georgia)",
    "aresriot.aws-chi1-prod.na-gp-chicago-1": "US Central (Illinois)",
    "aresriot.aws-chi1-prod.tournament-gp-chicago-1": "US Central (Illinois)",
    "aresriot.aws-chi2-prod.na-gp-chicago-2": "US Central (Illinois)",
    "aresriot.aws-ord1-prod.na-gp-chicago-1": "US Central (Illinois)",
    "aresriot.aws-ord1-prod.tournament-gp-chicago-1": "US Central (Illinois)",
    "aresriot.mtl-riot-ord2-3.na-gp-chicago-1": "US Central (Illinois)",
    "aresriot.mtl-riot-ord2-3.tournament-gp-chicago-1": "US Central (Illinois)",
    "aresriot.aws-dfw1-prod.na-gp-dallas-1": "US Central (Texas)",
    "aresriot.aws-dfw1-prod.tournament-gp-dallas-1": "US Central (Texas)",
    "aresriot.aws-dfw2-prod.na-gp-dallas-2": "US Central (Texas)",
    "aresriot.aws-rclusterprod-dfw1-1.na-gp-dallas-1": "US Central (Texas)",
    "aresriot.aws-rclusterprod-dfw1-1.tournament-gp-dallas-1":
        "US Central (Texas)",
    "aresriot.aws-rclusterprod-use1-1.na-gp-ashburn-1": "US East (N. Virginia 1)",
    "aresriot.aws-rclusterprod-use1-1.na-gp-ashburn-awsedge-1":
        "US East (N. Virginia 2)",
    "aresriot.aws-rclusterprod-use1-1.ext1-gp-ashburn-1": "US East (N. Virginia)",
    "aresriot.aws-rclusterprod-use1-1.pbe-gp-ashburn-1": "US East (N. Virginia)",
    "aresriot.aws-rclusterprod-use1-1.tournament-gp-ashburn-1":
        "US East (N. Virginia)",
    "aresriot.aws-use1-prod.ext1-gp-ashburn-1": "US East (N. Virginia)",
    "aresriot.aws-use1-prod.ext2-gp-ashburn-1": "US East (N. Virginia)",
    "aresriot.aws-use1-prod.na-gp-ashburn-1": "US East (N. Virginia)",
    "aresriot.aws-use1-prod.pbe-gp-ashburn-1": "US East (N. Virginia)",
    "aresriot.aws-use1-prod.tournament-gp-ashburn-1": "US East (N. Virginia)",
    "aresqa.aws-usw2-dev.sandbox1-gp-1": "US West",
    "aresriot.aws-rclusterprod-usw1-1.na-gp-norcal-1":
        "US West (N. California 1)",
    "aresriot.aws-rclusterprod-usw1-1.na-gp-norcal-awsedge-1":
        "US West (N. California 2)",
    "arespreprod.aws-usw1-prod.cert-gp-norcal-1": "US West (N. California)",
    "aresriot.aws-rclusterprod-usw1-1.ext1-gp-na2": "US West (N. California)",
    "aresriot.aws-rclusterprod-usw1-1.pbe-gp-norcal-1": "US West (N. California)",
    "aresriot.aws-rclusterprod-usw1-1.tournament-gp-norcal-1":
        "US West (N. California)",
    "aresriot.aws-usw1-prod.ext1-gp-na2": "US West (N. California)",
    "aresriot.aws-usw1-prod.ext1-gp-norcal-1": "US West (N. California)",
    "aresriot.aws-usw1-prod.ext2-gp-na1": "US West (N. California)",
    "aresriot.aws-usw1-prod.na-gp-norcal-1": "US West (N. California)",
    "aresriot.aws-usw1-prod.pbe-gp-norcal-1": "US West (N. California)",
    "aresriot.aws-usw1-prod.tournament-gp-norcal-1": "US West (N. California)",
    "aresriot.aws-rclusterprod-usw2-1.na-gp-oregon-1": "US West (Oregon 1)",
    "aresriot.aws-rclusterprod-usw2-1.na-gp-oregon-awsedge-1":
        "US West (Oregon 2)",
    "arespreprod.aws-usw2-prod.stage-release-1-gp-oregon-1": "US West (Oregon)",
    "arespreprod.aws-usw2-prod.stage2-gp-oregon-1": "US West (Oregon)",
    "aresriot.aws-rclusterprod-usw2-1.pbe-gp-oregon-1": "US West (Oregon)",
    "aresriot.aws-rclusterprod-usw2-1.tournament-gp-oregon-1": "US West (Oregon)",
    "aresriot.aws-usw2-prod.na-gp-oregon-1": "US West (Oregon)",
    "aresriot.aws-usw2-prod.pbe-gp-oregon-1": "US West (Oregon)",
    "aresriot.aws-usw2-prod.tournament-gp-oregon-1": "US West (Oregon)",
    "aresqa.aws-usw2-dev.main1-gp-1": "US West 1",
    "aresqa.aws-usw2-dev.stage1-gp-1": "US West 1",
    "globaltencent.tcc-sjc-dev.stage-val-gp-1": "US West 1",
    "globaltencent.tcc-sjc-dev.tcloudtest-stage-release-1-gp-1": "US West 1",
    "globaltencent.tcc-sjc-dev.val-gp-1": "US West 1",
    "aresqa.aws-usw2-dev.main1-gp-4": "US West 2",
    "globaltencent.tcc-sjc-dev.stage-val-gp-2": "US West 2",
    "globaltencent.tcc-sjc-dev.tcloudtest-stage-release-1-gp-2": "US West 2",
    "globaltencent.tcc-sjc-dev.val-gp-2": "US West 2",
    "aresriot.aws-rclusterprod-waw1-1.eu-gp-warsaw-1": "Warsaw",
    "aresriot.aws-rclusterprod-waw1-1.tournament-gp-warsaw-1": "Warsaw",
    "aresriot.aws-waw1-prod.eu-gp-warsaw-1": "Warsaw",
    "aresriot.aws-waw1-prod.tournament-gp-warsaw-1": "Warsaw",
    "tj.qcloud.vala-gp-3": "offline1",
    "tj.qcloud.valtest-gp-3": "offline1",
    "tj.qcloud.vala-gp-4": "offline2",
    "tj.qcloud.valtest-gp-4": "offline2",
    "tj.qcloud.vala-gp-1": "online1",
    "tj.qcloud.valtest-gp-1": "online1",
    "tj.qcloud.vala-gp-2": "online2",
    "tj.qcloud.valtest-gp-2": "online2",
    "na-1": "Virginia",
    "na-2": "California",
    "na-3": "Texas",
    "na-4": "Illinois",
    "eu-1": "Frankfurt",
    "eu-2": "Paris",
    "eu-3": "Stockholm",
    "eu-4": "Istanbul",
    "ap-1": "Singapore",
    "ap-2": "Tokyo",
    "ap-3": "Sydney",
    "ap-4": "Mumbai",
    "kr-1": "Seoul",
    "br-1": "Sao Paulo",
    "latam-1": "Santiago",
    "latam-2": "Mexico City",
};

export const resolveServerName = (gamePodId) => {
    const cleanId = (gamePodId || "").replace(/^p-/, "").toLowerCase();
    return GAME_PODS[cleanId] ?? GAME_PODS[gamePodId] ?? gamePodId;
};

// ──────────────────────────────────────────────
// Queue ID → display name
// ──────────────────────────────────────────────

const QUEUE_NAMES = {
    competitive: "Competitive",
    unrated: "Unrated",
    spikerush: "Spike Rush",
    deathmatch: "Deathmatch",
    ggteam: "Escalation",
    onefa: "Replication",
    custom: "Custom",
    snowball: "Snowball Fight",
    swiftplay: "Swift Play",
    hurm: "Team Deathmatch",
    valaram: "ARAM",
    newmap: "New Map",
    skirmish: "Skirmish",
    skirmish2v2: "Skirmish 2v2",
    "": "Custom",
};

const QUEUE_UUIDS = {
    spikerush: "e921d1e6-416b-c31f-1291-74930c330b7b",
    deathmatch: "a8790ec5-4237-f2f0-e93b-08a8e89865b2",
    ggteam: "a4ed6518-4741-6dcb-35bd-f884aecdc859",
    onefa: "4744698a-4513-dc96-9c22-a9aa437e4a58",
    snowball: "57038d6d-49b1-3a74-c5ef-3395d9f23a97",
    swiftplay: "5d0f264b-4ebe-cc63-c147-809e1374484b",
    hurm: "e086db66-47fd-e791-ca81-06a645ac7661",
    valaram: "1cd8901f-47af-49cb-d758-e2afd0eb2a39",
    skirmish: "0e9805d8-4af6-5ffb-f467-55806a6bc484",
    skirmish2v2: "0e9805d8-4af6-5ffb-f467-55806a6bc484",
};

export const resolveQueueName = (queueId, language = "en-US") => {
    const qid = queueId?.toLowerCase() || "";
    const uuid = QUEUE_UUIDS[qid];
    if (uuid && gamemodesCache && gamemodesCache[uuid]) {
        return gamemodesCache[uuid][language] ?? gamemodesCache[uuid]["en-US"] ?? (QUEUE_NAMES[qid] ?? queueId);
    }
    return QUEUE_NAMES[qid] ?? (queueId ?? "Unknown Mode");
};

/**
 * Queue ID → game mode display icon URL (from valorant-api.com/v1/gamemodes).
 * UUIDs are stable across patches; only add new rows when a new queue ships.
 */
const QUEUE_ICONS = {
    competitive: "https://media.valorant-api.com/gamemodes/96bd3920-4f36-d026-2b28-c683eb0bcac5/displayicon.png",
    unrated: "https://media.valorant-api.com/gamemodes/96bd3920-4f36-d026-2b28-c683eb0bcac5/displayicon.png",
    spikerush: "https://media.valorant-api.com/gamemodes/e921d1e6-416b-c31f-1291-74930c330b7b/displayicon.png",
    deathmatch: "https://media.valorant-api.com/gamemodes/a8790ec5-4237-f2f0-e93b-08a8e89865b2/displayicon.png",
    ggteam: "https://media.valorant-api.com/gamemodes/a4ed6518-4741-6dcb-35bd-f884aecdc859/displayicon.png",
    onefa: "https://media.valorant-api.com/gamemodes/4744698a-4513-dc96-9c22-a9aa437e4a58/displayicon.png",
    snowball: "https://media.valorant-api.com/gamemodes/57038d6d-49b1-3a74-c5ef-3395d9f23a97/displayicon.png",
    swiftplay: "https://media.valorant-api.com/gamemodes/5d0f264b-4ebe-cc63-c147-809e1374484b/displayicon.png",
    hurm: "https://media.valorant-api.com/gamemodes/e086db66-47fd-e791-ca81-06a645ac7661/displayicon.png",
    custom: "https://media.valorant-api.com/gamemodes/e2dc3878-4fe5-d132-28f8-3d8c259efcc6/displayicon.png",
    valaram: "https://media.valorant-api.com/gamemodes/1cd8901f-47af-49cb-d758-e2afd0eb2a39/displayicon.png",
    newmap: "https://media.valorant-api.com/gamemodes/96bd3920-4f36-d026-2b28-c683eb0bcac5/displayicon.png",
    skirmish: "https://media.valorant-api.com/gamemodes/0e9805d8-4af6-5ffb-f467-55806a6bc484/displayicon.png",
    skirmish2v2: "https://media.valorant-api.com/gamemodes/0e9805d8-4af6-5ffb-f467-55806a6bc484/displayicon.png",
    "": "https://media.valorant-api.com/gamemodes/e2dc3878-4fe5-d132-28f8-3d8c259efcc6/displayicon.png",
};

export const resolveQueueIcon = (queueId) =>
    QUEUE_ICONS[queueId?.toLowerCase()] ?? null;

/**
 * Queues where everyone is on a single team / free-for-all.
 * In these modes the embed uses description text instead of per-team fields.
 */
const SINGLE_TEAM_QUEUES = new Set(["deathmatch"]);

// ──────────────────────────────────────────────
// MMR parsing
// ──────────────────────────────────────────────

/**
 * Extract {currentTier, currentRR, peakTier, wins, games, winRate} from
 * the raw pd/mmr/v1/players response JSON.
 */
export const parseMMRData = (mmrJson, knownCurrentSeasonId = null) => {
    const empty = { currentTier: 0, currentRR: 0, peakTier: 0, wins: 0, games: 0, winRate: null, _rawLatestMatchId: null, _rawLatestMatchStartTime: null };
    if (!mmrJson) return empty;

    // Current rank — best source is the latest competitive update
    const latest = mmrJson.LatestCompetitiveUpdate;
    let currentTier = latest?.TierAfterUpdate ?? 0;
    let currentRR = 0;

    // RR after the most recent update
    if (latest?.RankedRatingAfterUpdate != null) {
        currentRR = latest.RankedRatingAfterUpdate;
    }

    // If the player has seasonal info, also get the current season's RR
    const seasonal = mmrJson.QueueSkills?.competitive?.SeasonalInfoBySeasonID ?? {};
    if (latest?.SeasonID && seasonal[latest.SeasonID]) {
        currentRR = seasonal[latest.SeasonID].RankedRating ?? currentRR;
        if (!currentTier) currentTier = seasonal[latest.SeasonID].CompetitiveTier ?? 0;
    }

    // If we know the current season and the player's last game was in a
    // different (older) season, show their current-season rank instead.
    // A player who hasn't played ranked this act should appear as Unranked.
    if (knownCurrentSeasonId && latest?.SeasonID && latest.SeasonID !== knownCurrentSeasonId) {
        const thisSeasonInfo = seasonal[knownCurrentSeasonId];
        if (!thisSeasonInfo || (thisSeasonInfo.NumberOfGames ?? 0) === 0) {
            currentTier = 0;
            currentRR = 0;
        } else {
            currentTier = thisSeasonInfo.CompetitiveTier ?? 0;
            currentRR = thisSeasonInfo.RankedRating ?? 0;
        }
    }

    // Peak rank — scan all seasons, remember which season achieved it
    let peakTier = 0;
    let peakSeasonId = null;
    let wins = 0, games = 0;
    for (const [seasonId, info] of Object.entries(seasonal)) {
        if ((info.CompetitiveTier ?? 0) > peakTier) {
            peakTier = info.CompetitiveTier;
            peakSeasonId = seasonId;
        }
    }

    // Wins/games from the current season when known, otherwise the latest update's season
    const statsSeasonId = (knownCurrentSeasonId && seasonal[knownCurrentSeasonId])
        ? knownCurrentSeasonId
        : latest?.SeasonID;
    if (statsSeasonId && seasonal[statsSeasonId]) {
        wins = seasonal[statsSeasonId].NumberOfWinsWithPlacements ?? 0;
        games = seasonal[statsSeasonId].NumberOfGames ?? 0;
    }

    const winRate = games > 0 ? Math.round((wins / games) * 100) : null;
    const losses = games - wins;

    return {
        currentTier, currentRR, peakTier, peakSeasonId, wins, losses, games, winRate,
        _rawLatestMatchId: latest?.MatchID ?? null,
        _rawLatestMatchStartTime: latest?.MatchStartTime ?? null
    };
};

// ──────────────────────────────────────────────
// Party / Matchmaking fetch
// ──────────────────────────────────────────────

/**
 * Fetch party/matchmaking data for a user.
 * Returns { success, state: "queuing", matchId: partyId, queueId }
 * or       { success, state: "not_queuing" }
 * or       { success: false, ... } on auth failure.
 */
export const getPartyData = async (id, account = null) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return { ...authResult, state: null };

    const user = getUser(id, account);
    const base = glzUrl(user);
    const headers = authHeaders(user);

    // Check if the user is in a party
    const playerResp = await fetch(
        `${base}/parties/v1/players/${user.puuid}`,
        { headers }
    );

    if (playerResp.statusCode !== 200) {
        return { success: true, state: "not_queuing" };
    }

    const { CurrentPartyID: partyId } = JSON.parse(playerResp.body);
    if (!partyId) return { success: true, state: "not_queuing" };

    // Fetch party data
    const partyResp = await fetch(
        `${base}/parties/v1/parties/${partyId}`,
        { headers }
    );

    if (partyResp.statusCode !== 200) {
        return { success: true, state: "not_queuing" };
    }

    const partyJson = JSON.parse(partyResp.body);
    const members = (partyJson.Members || []).map(m => ({ puuid: m.Subject, isLeader: m.IsOwner }));
    const eligibleQueues = partyJson.EligibleQueues || [];
    const inviteCode = partyJson.InviteCode || null;
    const preferredGamePods = partyJson.MatchmakingData?.PreferredGamePods || [];

    let queueId = partyJson.MatchmakingData?.QueueID ?? "";
    if (partyJson.State === "CUSTOM_GAME_SETUP") queueId = "custom";

    if (partyJson.State !== "MATCHMAKING") {
        return {
            success: true,
            state: "not_queuing",
            matchId: partyId,
            queueId,
            eligibleQueues,
            members,
            inviteCode,
            preferredGamePods
        };
    }

    return {
        success: true,
        state: "queuing",
        matchId: partyId,
        queueId,
        queueName: resolveQueueName(queueId),
        eligibleQueues,
        members,
        inviteCode,
        preferredGamePods
    };
};

export const makePartyCode = async (id, account, partyId) => {
    const user = getUser(id, account);
    const base = glzUrl(user);
    const headers = { ...authHeaders(user), "Content-Type": "application/json" };
    const resp = await fetch(`${base}/parties/v1/parties/${partyId}/invitecode`, {
        method: "POST",
        headers,
        body: "{}"
    });
    console.log(`[livegame] makePartyCode for ${partyId} on ${base} returned:`, resp.statusCode);
    if (resp.statusCode === 200) {
        return JSON.parse(resp.body)?.InviteCode || true;
    }
    return false;
};

export const removePartyCode = async (id, account, partyId) => {
    const user = getUser(id, account);
    const base = glzUrl(user);
    const headers = { ...authHeaders(user), "Content-Type": "application/json" };
    const resp = await fetch(`${base}/parties/v1/parties/${partyId}/invitecode`, {
        method: "DELETE",
        headers
    });
    console.log(`[livegame] removePartyCode for ${partyId} on ${base} returned:`, resp.statusCode);
    return resp.statusCode === 200;
};

// ──────────────────────────────────────────────
// Agent endpoints
// ──────────────────────────────────────────────

export const selectAgent = async (id, account, matchId, agentId) => {
    const user = getUser(id, account);
    const base = glzUrl(user);
    const headers = authHeaders(user);

    const resp = await fetch(
        `${base}/pregame/v1/matches/${matchId}/select/${agentId}`,
        { method: "POST", headers }
    );
    return resp.statusCode === 200;
};

export const lockAgent = async (id, account, matchId, agentId) => {
    const user = getUser(id, account);
    const base = glzUrl(user);
    const headers = authHeaders(user);

    const resp = await fetch(
        `${base}/pregame/v1/matches/${matchId}/lock/${agentId}`,
        { method: "POST", headers }
    );
    return resp.statusCode === 200;
};

export const startQueue = async (id, account, partyId) => {
    const user = getUser(id, account);
    const base = glzUrl(user);
    const headers = authHeaders(user);
    const resp = await fetch(`${base}/parties/v1/parties/${partyId}/matchmaking/join`, { method: "POST", headers });
    return resp.statusCode === 200;
};

export const cancelQueue = async (id, account, partyId) => {
    const user = getUser(id, account);
    const base = glzUrl(user);
    const headers = authHeaders(user);
    const resp = await fetch(`${base}/parties/v1/parties/${partyId}/matchmaking/leave`, { method: "POST", headers });
    return resp.statusCode === 200;
};

export const changeQueue = async (id, account, partyId, queueId) => {
    const user = getUser(id, account);
    const base = glzUrl(user);
    const headers = authHeaders(user);
    // First, escape Custom Match restrictions back into standard modes
    // console.log(`[livegame] Attempting to escape Custom Match via /makeDefault for party ${partyId}`);
    // const escResp = await fetch(`${base}/parties/v1/parties/${partyId}/makeDefault?queueID=${queueId}`, {
    //     method: "POST",
    //     headers
    // });
    // console.log(`[livegame] /makeDefault status: ${escResp.statusCode}`);

    if (queueId === "custom") {
        console.log(`[livegame] Initiating transition to Custom Match via /makecustomgame for ${partyId}`);
        const resp = await fetch(`${base}/parties/v1/parties/${partyId}/makecustomgame`, {
            method: "POST",
            headers
        });
        console.log(`[livegame] Riot API Custom Match /makecustomgame lock returned:`, resp.statusCode, resp.body);
        return resp.statusCode === 200;
    }

    console.log(`[livegame] Initiating transition to standard queue ${queueId} via /queue for ${partyId}`);
    const resp = await fetch(`${base}/parties/v1/parties/${partyId}/queue`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ queueID: queueId })
    });
    console.log(`[livegame] Riot API Matchmaking /queue switch returned:`, resp.statusCode);
    return resp.statusCode === 200;
};



export const getOwnedAgents = async (user) => {
    const base = pdUrl(user);
    const headers = authHeaders(user);

    const req = await fetch(`${base}/store/v1/entitlements/${user.puuid}/01bb38e1-da47-4e6a-9b3d-945fe4655707`, { headers });
    let owned = [];
    if (req.statusCode === 200) {
        const json = JSON.parse(req.body);
        if (json.Entitlements) {
            owned = json.Entitlements.map(ent => ent.ItemID.toLowerCase());
        }
    }

    const defaultAgents = [
        "add6443a-41bd-e414-f6ad-e58d267f4e95", // Jett
        "eb93336a-449b-9c1b-0a54-a891f7921d69", // Phoenix
        "320b2a48-4d9b-a075-30f1-1f93a9b638fa", // Sova
        "9f0d8ba9-4140-b941-57d3-a7ad57c6b417", // Brimstone
        "569fdd95-4d10-43ab-ca70-79becc718b46"  // Sage
    ];

    const allEntitlements = new Set([...owned, ...defaultAgents]);

    const allPlayables = await getAllPlayableAgents();
    return allPlayables.filter(agentId => allEntitlements.has(agentId.toLowerCase()));
};

// ──────────────────────────────────────────────
// Pre-game fetch
// ──────────────────────────────────────────────

/**
 * Fetch pre-game data for a user.
 * Returns { success, state: "pregame", matchId, mapId, mapName, queueId, queueName, players }
 * or       { success, state: "not_in_pregame" }
 * or       { success: false, ... } on auth failure.
 */
export const getPreGameData = async (id, account = null) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return { ...authResult, state: null };

    const user = getUser(id, account);
    const base = glzUrl(user);
    const headers = authHeaders(user);

    // Check if the user is in pre-game
    const playerResp = await fetch(
        `${base}/pregame/v1/players/${user.puuid}`,
        { headers }
    );

    if (playerResp.statusCode !== 200) {
        return { success: true, state: "not_in_pregame" };
    }

    const { MatchID: matchId } = JSON.parse(playerResp.body);

    // Fetch match data
    const matchResp = await fetch(
        `${base}/pregame/v1/matches/${matchId}`,
        { headers }
    );

    if (matchResp.statusCode !== 200) {
        return { success: true, state: "not_in_pregame" };
    }

    const matchJson = JSON.parse(matchResp.body);

    const mapId = matchJson.MapID ?? "";
    // GameConfig.GameMode is a URL like ".../modes/competitive.json".
    // Split on "/" and strip the extension rather than replacing a hardcoded
    // prefix — this is robust to any URL path changes Riot may make.
    const rawMode = matchJson.GameConfig?.GameMode ?? "";
    const rawSlug = rawMode
        ? rawMode.split("/").pop().replace(/\.json$/i, "").toLowerCase()
        : "";
    // Normalise mode slugs that differ from our QUEUE_NAMES keys.
    // "customgame" → "custom"  (pre-game Custom lobbies)
    // "standard"   → "unrated" (older Riot clients)
    const SLUG_ALIASES = { customgame: "custom", standard: "unrated" };
    const queueId = SLUG_ALIASES[rawSlug] ?? rawSlug;

    const gamePodId = matchJson.GamePodID ?? "";
    const serverName = resolveServerName(gamePodId);

    const rawPlayers = (matchJson.AllyTeam?.Players ?? []).map((p) => ({
        puuid: p.Subject,
        teamId: "Ally",
        isAlly: true,
        agentId: p.CharacterID || null,
        selectionState: p.CharacterSelectionState || "",
        incognito: p.PlayerIdentity?.Incognito ?? false,
        accountLevel: p.PlayerIdentity?.AccountLevel ?? null,
        isHideAccountLevel: p.PlayerIdentity?.HideAccountLevel ?? false,
    }));

    return {
        success: true,
        state: "pregame",
        matchId,
        mapId,
        mapName: resolveMapName(mapId),
        serverName,
        queueId,
        queueName: resolveQueueName(queueId),
        players: rawPlayers,
        userPuuid: user.puuid,
    };
};

// ──────────────────────────────────────────────
// In-game fetch
// ──────────────────────────────────────────────

/**
 * Fetch in-game data for a user.
 * Returns { success, state: "ingame", matchId, mapId, mapName, queueId, queueName, players, userTeamId }
 * or       { success, state: "not_in_game" }
 * or       { success: false, ... } on auth failure.
 */
export const getInGameData = async (id, account = null) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return { ...authResult, state: null };

    const user = getUser(id, account);
    const base = glzUrl(user);
    const headers = authHeaders(user);

    // Check if the user is in a live game
    const playerResp = await fetch(
        `${base}/core-game/v1/players/${user.puuid}`,
        { headers }
    );

    if (playerResp.statusCode !== 200) {
        return { success: true, state: "not_in_game" };
    }

    const { MatchID: matchId } = JSON.parse(playerResp.body);

    // Fetch match data
    const matchResp = await fetch(
        `${base}/core-game/v1/matches/${matchId}`,
        { headers }
    );

    if (matchResp.statusCode !== 200) {
        return { success: true, state: "not_in_game" };
    }

    const matchJson = JSON.parse(matchResp.body);

    const mapId = matchJson.MapID ?? "";
    const gamePodId = matchJson.GamePodID ?? "";
    const serverName = resolveServerName(gamePodId);
    const queueId = matchJson.MatchmakingData?.QueueID ?? "";
    const userTeamId = matchJson.Players
        .find(p => p.Subject === user.puuid)?.TeamID ?? null;

    const rawPlayers = matchJson.Players.map((p) => ({
        puuid: p.Subject,
        teamId: p.TeamID,
        isAlly: p.TeamID === userTeamId,
        agentId: p.CharacterID ?? null,
        incognito: p.PlayerIdentity?.Incognito ?? false,
        accountLevel: p.PlayerIdentity?.AccountLevel ?? null,
        isHideAccountLevel: p.PlayerIdentity?.HideAccountLevel ?? false,
    }));

    return {
        success: true,
        state: "ingame",
        matchId,
        mapId,
        mapName: resolveMapName(mapId),
        serverName,
        queueId,
        queueName: resolveQueueName(queueId),
        players: rawPlayers,
        userTeamId,
        userPuuid: user.puuid,
    };
};

// ──────────────────────────────────────────────
// Bulk data fetchers
// ──────────────────────────────────────────────

/**
 * Batch-fetch MMR for a list of PUUIDs using the caller's auth.
 * Returns Map<puuid, parsedMMR>.
 */
const fetchPlayerMMRs = async (user, puuids) => {
    const headers = authHeaders(user);
    const pd = pdUrl(user);

    const results = await Promise.allSettled(
        puuids.map(puuid =>
            fetch(`${pd}/mmr/v1/players/${puuid}`, { headers })
                .then(r => r.statusCode === 200 ? JSON.parse(r.body) : null)
        )
    );

    const out = new Map();
    for (let i = 0; i < puuids.length; i++) {
        const raw = results[i].status === "fulfilled" ? results[i].value : null;
        out.set(puuids[i], parseMMRData(raw, currentSeasonId));
    }
    return out;
};

/**
 * Batch-fetch Riot IDs (GameName#TagLine) for a list of PUUIDs.
 * Returns Map<puuid, "GameName#Tag"> (or null for incognito/missing).
 */
const fetchPlayerNames = async (user, puuids) => {
    const headers = { ...authHeaders(user), "Content-Type": "application/json" };
    const pd = pdUrl(user);

    const out = new Map();
    try {
        const resp = await fetch(`${pd}/name-service/v2/players`, {
            method: "PUT",
            headers,
            body: JSON.stringify(puuids),
        });
        if (resp.statusCode === 200) {
            for (const entry of JSON.parse(resp.body)) {
                if (entry.GameName) {
                    out.set(entry.Subject, `${entry.GameName}#${entry.TagLine}`);
                }
            }
        }
    } catch (e) {
        console.error("[livegame] fetchPlayerNames failed:", e);
    }
    return out;
};

/**
 * Fetch match details and score for multiple players, deduplicating requests.
 * @returns Map<puuid, {win, allyScore, enemyScore}>
 */
const fetchMatchScores = async (user, puuidMatchMap) => {
    const pd = pdUrl(user);
    const headers = authHeaders(user);
    const matchIds = [...new Set(Object.values(puuidMatchMap).filter(Boolean))];

    // Fetch unique matches
    const detailsMap = new Map();
    const results = await Promise.allSettled(
        matchIds.map(matchId =>
            fetch(`${pd}/match-details/v1/matches/${matchId}`, { headers })
                .then(r => r.statusCode === 200 ? JSON.parse(r.body) : null)
        )
    );

    for (let i = 0; i < matchIds.length; i++) {
        if (results[i].status === "fulfilled" && results[i].value) {
            detailsMap.set(matchIds[i], results[i].value);
        }
    }

    const scores = new Map();
    for (const [puuid, matchId] of Object.entries(puuidMatchMap)) {
        if (!matchId) continue;
        const json = detailsMap.get(matchId);
        if (!json) continue;

        const player = json.players?.find(p => p.subject === puuid);
        if (!player) continue;

        const allyTeam = json.teams?.find(t => t.teamId === player.teamId);
        const enemyTeam = json.teams?.find(t => t.teamId !== player.teamId);
        if (allyTeam && enemyTeam) {
            scores.set(puuid, {
                win: allyTeam.won !== null ? allyTeam.won : (allyTeam.roundsWon > enemyTeam.roundsWon),
                allyScore: allyTeam.roundsWon,
                enemyScore: enemyTeam.roundsWon
            });
        }
    }
    return scores;
};

// ──────────────────────────────────────────────
// Player enrichment
// ──────────────────────────────────────────────

/**
 * Enrich raw player objects with name, rank, agent, and level info.
 * modifies players in-place AND returns them.
 */
const enrichPlayers = async (id, account, rawPlayers, queueId = "") => {
    const user = getUser(id, account);
    const puuids = rawPlayers.map(p => p.puuid);
    const showCompStats = queueId === "competitive" || queueId === "skirmish" || queueId === "skirmish 2v2";

    // loadSeasons must finish first so that currentSeasonId (module-level) is
    // populated before fetchPlayerMMRs calls parseMMRData(raw, currentSeasonId).
    // Running them in parallel caused a race where every player appeared Unranked
    // on the first /livegame refresh while already in a match.
    const seasonMap = seasonsCache; // Pre-warmed by fetchLiveGame
    const [mmrMap, nameMap] = await Promise.all([
        fetchPlayerMMRs(user, puuids),
        fetchPlayerNames(user, puuids.filter(p => !rawPlayers.find(rp => rp.puuid === p)?.incognito)),
    ]);

    // Competitive updates — one request per player, run in parallel to get matchId
    const compScoresMap = new Map();
    if (showCompStats) {
        const puuidMatchMap = {};
        const TWO_MONTHS_MS = 60 * 24 * 60 * 60 * 1000;
        const now = Date.now();

        for (const puuid of puuids) {
            const mmr = mmrMap.get(puuid);
            if (mmr && mmr._rawLatestMatchId && mmr._rawLatestMatchStartTime) {
                if (mmr._rawLatestMatchStartTime >= now - TWO_MONTHS_MS) {
                    puuidMatchMap[puuid] = mmr._rawLatestMatchId;
                } else {
                    puuidMatchMap[puuid] = null;
                }
            } else {
                puuidMatchMap[puuid] = null;
            }
        }

        const scores = await fetchMatchScores(user, puuidMatchMap);
        for (const [puuid, score] of scores.entries()) {
            compScoresMap.set(puuid, [score]);
        }
    }

    // Enrich each player
    const enriched = await Promise.all(rawPlayers.map(async (p, idx) => {
        const mmr = mmrMap.get(p.puuid);
        const name = !p.incognito ? (nameMap.get(p.puuid) ?? null) : null;

        // Resolve agent and tier icons/names in parallel
        const [agentInfo, currentTierInfo, peakTierInfo] = await Promise.all([
            p.agentId ? resolveAgent(p.agentId) : Promise.resolve({ name: "Unknown", icon: null, role: null }),
            resolveTier(mmr?.currentTier ?? 0),
            resolveTier(mmr?.peakTier ?? 0),
        ]);

        // Level: always carry through; levelHidden flag lets the embed show "?"
        const level = p.accountLevel ?? null;
        const levelHidden = p.isHideAccountLevel ?? false;

        return {
            ...p,
            // Identity: incognito players show their locked agent name so the row
            // reads "<agent_emoji>  `AgentName`". "Player N" is the fallback when
            // the agent is not yet known (pre-game, agent not locked).
            riotId: p.incognito
                // In pre-game, selectionState is an explicit string ("locked" / "").
                // In-game (core-game), the field is absent (undefined) — agents
                // are always locked once the match starts, so treat undefined as locked.
                ? (p.agentId && (p.selectionState === "locked" || p.selectionState === undefined) && agentInfo.names
                    ? agentInfo.names["en-US"]
                    : `Player ${idx + 1}`)
                : (name ?? p.puuid.slice(0, 8)),
            // Agent
            agentName: p.agentId ? agentInfo.names : null,
            agentIcon: p.agentId ? agentInfo.icon : null,
            selectionState: p.selectionState ?? "",
            // Rank
            currentTier: mmr?.currentTier ?? 0,
            currentRR: mmr?.currentRR ?? 0,
            currentTierName: currentTierInfo.name,
            currentTierIcon: currentTierInfo.icon,
            // Peak rank
            peakTier: mmr?.peakTier ?? 0,
            peakTierName: peakTierInfo.name,
            peakTierIcon: peakTierInfo.icon,
            peakActLabel: seasonMap.get(mmr?.peakSeasonId ?? "") ?? null,
            // Win stats
            wins: mmr?.wins ?? 0,
            losses: mmr?.losses ?? 0,
            games: mmr?.games ?? 0,
            winRate: mmr?.winRate ?? null,
            // Level
            accountLevel: level,
            levelHidden,
            // Recent competitive match results ([] if not competitive)
            recentMatches: compScoresMap.get(p.puuid) ?? [],
        };
    }));

    return enriched;
};

// ──────────────────────────────────────────────
// Top-level export
// ──────────────────────────────────────────────

/**
 * Detect current game state and return enriched match data.
 *
 * Flow:
 *   1. Try in-game first (most common case after match loads).
 *   2. Fall back to pre-game.
 *   3. Otherwise return state "not_in_game".
 *
 * Returns:
 *   { success: false, ...authError }
 *   { success: true, state: "not_in_game" }
 *   { success: true, state: "pregame",  mapName, queueName, players: [{...enriched}] }
 *   { success: true, state: "ingame",   mapName, queueName, players: [{...enriched}],
 *                                       allyPlayers, enemyPlayers }
 */
export const fetchLiveGame = async (id, account = null) => {
    // 1. Ensure static caches are ready before the parallel API calls
    await Promise.all([loadAgents(), loadCompetitiveTiers(), loadMapImages(), loadSeasons(), loadGamemodes()]);

    const authResult = await authUser(id, account);
    if (!authResult.success) return { ...authResult, state: null };

    // 2. Parallelize state checks
    const [inGame, preGame, party] = await Promise.all([
        getInGameData(id, account),
        getPreGameData(id, account),
        getPartyData(id, account)
    ]);

    if (!inGame.success) return inGame;
    if (!preGame.success) return preGame;
    if (!party.success) return party;

    if (inGame.state === "ingame") {
        const enriched = await enrichPlayers(id, account, inGame.players, inGame.queueId);
        const allyPlayers = enriched.filter(p => p.isAlly);
        const enemyPlayers = enriched.filter(p => !p.isAlly);
        const mapImage = await resolveMapImage(inGame.mapId);
        const isSingleTeam = SINGLE_TEAM_QUEUES.has(inGame.queueId?.toLowerCase());
        const queueIcon = resolveQueueIcon(inGame.queueId);
        return { ...inGame, players: enriched, allyPlayers, enemyPlayers, mapImage, isSingleTeam, queueIcon };
    }

    if (preGame.state === "pregame") {
        const enriched = await enrichPlayers(id, account, preGame.players, preGame.queueId);
        const mapImage = await resolveMapImage(preGame.mapId);
        const isSingleTeam = SINGLE_TEAM_QUEUES.has(preGame.queueId?.toLowerCase());
        const queueIcon = resolveQueueIcon(preGame.queueId);
        return { ...preGame, players: enriched, allyPlayers: enriched, enemyPlayers: [], mapImage, isSingleTeam, queueIcon };
    }

    if (party.state === "queuing" || party.state === "not_queuing") {
        let enriched = [];
        if (party.members && party.members.length > 0) {
            enriched = await enrichPlayers(id, account, party.members, party.queueId);
        }

        const user = getUser(id, account);
        if (party.state === "queuing") {
            return {
                success: true,
                state: "queuing",
                matchId: party.matchId,
                queueId: party.queueId,
                queueName: party.queueName,
                allyPlayers: enriched,
                eligibleQueues: party.eligibleQueues,
                userPuuid: user.puuid,
                inviteCode: party.inviteCode,
                preferredGamePods: party.preferredGamePods
            };
        } else {
            return {
                success: true,
                state: "not_in_game",
                matchId: party.matchId,
                queueId: party.queueId,
                allyPlayers: enriched,
                eligibleQueues: party.eligibleQueues,
                userPuuid: user.puuid,
                inviteCode: party.inviteCode,
                preferredGamePods: party.preferredGamePods
            };
        }
    }

    return { success: true, state: "not_in_game" };
};
