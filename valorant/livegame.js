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
import config from "../misc/config.js";
import unofficialValorantApi from "unofficial-valorant-api";

let VAPI = null;
const getVAPI = () => {
    if (!VAPI && config.HDevToken) VAPI = new unofficialValorantApi(config.HDevToken);
    return VAPI;
};

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
            const rawName = tier.tierName === "Unused" ? "Unranked" : tier.tierName.replaceAll("_", " ");
            const formattedName = rawName.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
            competitiveTiersCache[tier.tier] = {
                name: formattedName,
                color: "#" + (tier.color ?? "000000").slice(0, 6),
                icon: tier.largeIcon ?? tier.smallIcon ?? null,
            };
        }
    } catch (e) {
        console.error("[livegame] Failed to load competitive tiers:", e);
        competitiveTiersCache = {};
    }
};

let gamemodeIconsCache = null;

/** Invalidate all static caches (call when skins/version reloads). */
export const clearLiveGameCache = () => {
    agentsCache = null;
    competitiveTiersCache = null;
    gamemodesCache = null;
    gamemodeIconsCache = null;
    mapNamesCache = null;
    seasonsCache = null;
    currentSeasonId = null;
    nextSeasonCheck = 0;
    playerMmrCache.clear();
    playerRecentMatchesCache.clear();
    playerCombatStatsCache.clear();
    playerNameCache.clear();
};

const loadGamemodes = async () => {
    if (gamemodesCache) return;
    try {
        const req = await globalThis.fetch("https://valorant-api.com/v1/gamemodes?language=all");
        const json = await req.json();
        gamemodesCache = {};
        gamemodeIconsCache = {};
        for (const mode of json.data) {
            const uuid = mode.uuid.toLowerCase();
            gamemodesCache[uuid] = {};
            if (mode.displayIcon) gamemodeIconsCache[uuid] = mode.displayIcon;
            if (mode.displayName && typeof mode.displayName === "object") {
                // Populate the cache with localized strings (e.g. ['en-US': 'Swiftplay', ...])
                for (const [lang, val] of Object.entries(mode.displayName)) {
                    gamemodesCache[uuid][lang] = val;
                }
            } else {
                gamemodesCache[uuid]["en-US"] = mode.displayName;
            }
        }
    } catch (e) {
        console.error("[livegame] Failed to load gamemodes:", e);
        gamemodesCache = {};
        gamemodeIconsCache = {};
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
// Map data cache — display name per mapUrl
// ──────────────────────────────────────────────

let mapNamesCache = null;

const loadMapNames = async () => {
    if (mapNamesCache) return;
    try {
        const req = await fetch("https://valorant-api.com/v1/maps");
        const json = JSON.parse(req.body);
        mapNamesCache = {};
        for (const m of json.data) {
            if (m.mapUrl && m.displayName) mapNamesCache[m.mapUrl] = m.displayName;
        }
    } catch (e) {
        console.error("[livegame] Failed to load map names:", e);
        mapNamesCache = {};
    }
};

// ──────────────────────────────────────────────
// Seasons cache — act UUID → label ("E5A3", "V25A1", …)
// ──────────────────────────────────────────────

let seasonsCache = null;
let currentSeasonId = null;   // UUID of the currently active act (populated by loadSeasons)
let nextSeasonCheck = 0;      // re-derive the active act once the current one ends

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
    // Acts roll over every ~2 months. Caching this for the process lifetime left
    // currentSeasonId pointing at the *previous* act, and parseMMRData would then
    // read everyone's old-act entry and report it as their current rank until the
    // bot was restarted. Expire at the act's own endTime instead.
    if (seasonsCache && Date.now() < nextSeasonCheck) return seasonsCache;

    const seasons = new Map();
    let activeId = null;
    let activeEndsAt = 0;
    try {
        const req = await fetch("https://valorant-api.com/v1/seasons");
        if (req.statusCode === 200) {
            const { data } = JSON.parse(req.body);
            const now = Date.now();
            for (const s of data) {
                if (s.type === "EAresSeasonType::Act") {
                    const label = actLabelFromPath(s.assetPath);
                    if (label) seasons.set(s.uuid, label);
                    // Detect the currently active act so parseMMRData can
                    // distinguish "unranked this season" from "old season rank".
                    if (s.startTime && s.endTime) {
                        const start = new Date(s.startTime).getTime();
                        const end = new Date(s.endTime).getTime();
                        if (now >= start && now <= end) {
                            activeId = s.uuid;
                            activeEndsAt = end;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error("[livegame] loadSeasons failed:", e);
    }

    // Keep the previous cache on a failed refresh rather than blanking it.
    if (seasons.size > 0 || !seasonsCache) seasonsCache = seasons;
    if (activeId) currentSeasonId = activeId;
    // Re-check when the act ends, but never more than hourly — a failed fetch or
    // a gap between acts must not turn this into a per-call request.
    nextSeasonCheck = Math.max(activeEndsAt, Date.now() + 60 * 60 * 1000);
    return seasonsCache;
};

/**
 * Game pod ids are structured, e.g.
 *   aresriot.aws-euc1-prod.eu-gp-frankfurt-1
 *   aresriot.aws-rclusterprod-use1-1.na-gp-ashburn-awsedge-1
 * so the datacentre city is just the `-gp-<city>` segment. Pulling it out with
 * a regex handles new pods automatically, which a hardcoded table never did.
 *
 * Only cities whose display name isn't Capitalize(city) need an entry here.
 */
const POD_CITIES = {
    ashburn: "N. Virginia",
    norcal: "N. California",
    atlanta: "Georgia",
    dallas: "Texas",
    chicago: "Illinois",
    saopaulo: "Sao Paulo",
    hongkong: "Hong Kong",
    capetown: "Cape Town",
    mexicocity: "Mexico City",
    mexico: "Mexico City",
    bogota: "Bogotá",
};

/** Party MatchmakingData.PreferredGamePods uses short region ids instead. */
const REGION_PODS = {
    "na-1": "Virginia", "na-2": "California", "na-3": "Texas", "na-4": "Illinois",
    "eu-1": "Frankfurt", "eu-2": "Paris", "eu-3": "Stockholm", "eu-4": "Istanbul",
    "ap-1": "Singapore", "ap-2": "Tokyo", "ap-3": "Sydney", "ap-4": "Mumbai",
    "kr-1": "Seoul", "br-1": "Sao Paulo", "latam-1": "Santiago", "latam-2": "Mexico City",
};

export const resolveServerName = (gamePodId) => {
    if (!gamePodId) return gamePodId;
    const id = gamePodId.replace(/^p-/, "").toLowerCase();
    if (REGION_PODS[id]) return REGION_PODS[id];

    // {3,} so region-suffix pods (`ext1-gp-eu1`) don't render as "Eu";
    // they fall through to the raw id, same as the old table's fallback.
    const city = id.match(/-gp-([a-z]{3,})/)?.[1];
    if (!city) return gamePodId;
    return POD_CITIES[city] ?? city[0].toUpperCase() + city.slice(1);
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
    retake: "Retake",
    fortcollins: "Retake",
    knockout: "Knockout",
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
    retake: "75b7b658-472c-0264-cbe6-049abf14f54b",
    fortcollins: "75b7b658-472c-0264-cbe6-049abf14f54b",
    knockout: "1a4a3fd5-4966-62cb-7fe4-15b0317f5c80",
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
    retake: "https://media.valorant-api.com/gamemodes/75b7b658-472c-0264-cbe6-049abf14f54b/displayicon.png",
    fortcollins: "https://media.valorant-api.com/gamemodes/75b7b658-472c-0264-cbe6-049abf14f54b/displayicon.png",
    knockout: "https://media.valorant-api.com/gamemodes/1a4a3fd5-4966-62cb-7fe4-15b0317f5c80/displayicon.png",
    "": "https://media.valorant-api.com/gamemodes/e2dc3878-4fe5-d132-28f8-3d8c259efcc6/displayicon.png",
};

export const resolveQueueIcon = (queueId) => {
    const qid = queueId?.toLowerCase() || "";
    const uuid = QUEUE_UUIDS[qid];
    if (uuid && gamemodeIconsCache && gamemodeIconsCache[uuid]) {
        return gamemodeIconsCache[uuid];
    }
    return QUEUE_ICONS[qid] ?? null;
};

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
    const empty = { currentTier: 0, currentRR: 0, peakTier: 0, wins: 0, games: 0, winRate: null };
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

    return { currentTier, currentRR, peakTier, peakSeasonId, wins, losses, games, winRate };
};

const safeJson = (str) => {
    try { return JSON.parse(str); } catch { return null; }
};

/**
 * GLZ "am I in X?" probe: GET /{path}/v1/players/{puuid} → the id it reports,
 * or null when the user isn't in that state.
 *
 * Split out of the three getters so fetchLiveGame can run all three probes in
 * a single round trip and then pay for the detail fetch of only whichever one
 * hit. The states are mutually exclusive, so pulling full party detail while
 * the user was mid-match was always a wasted request.
 */
const probeState = async (user, path, idField) => {
    const resp = await fetch(`${glzUrl(user)}/${path}/v1/players/${user.puuid}`, { headers: authHeaders(user) });
    if (resp.statusCode !== 200) return null;
    return safeJson(resp.body)?.[idField] ?? null;
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
export const getPartyData = async (id, account = null, knownPartyId = undefined) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return { ...authResult, state: null };

    const user = getUser(id, account);
    if (!user) return { success: false, state: null };
    const base = glzUrl(user);
    const headers = authHeaders(user);

    // knownPartyId: undefined = probe for it, null = caller already knows there
    // is no party, string = caller already probed and we skip straight to detail.
    const partyId = knownPartyId === undefined
        ? await probeState(user, "parties", "CurrentPartyID")
        : knownPartyId;
    if (!partyId) return { success: true, state: "not_queuing" };

    // Fetch party data
    const partyResp = await fetch(
        `${base}/parties/v1/parties/${partyId}`,
        { headers }
    );

    if (partyResp.statusCode !== 200) {
        return { success: true, state: "not_queuing" };
    }

    const partyJson = safeJson(partyResp.body);
    if (!partyJson) return { success: true, state: "not_queuing" };

    const members = (partyJson.Members || []).map(m => ({ puuid: m.Subject, isLeader: m.IsOwner, matchTier: m.CompetitiveTier || 0, partyId }));
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
        eligibleQueues,
        members,
        inviteCode,
        preferredGamePods
    };
};

export const makePartyCode = async (id, account, partyId) => {
    const auth = await authUser(id, account);
    if (!auth.success) return false;
    const user = getUser(id, account);
    if (!user) return false;
    const base = glzUrl(user);
    const headers = { ...authHeaders(user), "Content-Type": "application/json" };
    const resp = await fetch(`${base}/parties/v1/parties/${partyId}/invitecode`, {
        method: "POST",
        headers,
        body: "{}"
    });
    console.log(`[livegame] makePartyCode for ${partyId} on ${base} returned:`, resp.statusCode);
    if (resp.statusCode === 200) {
        return safeJson(resp.body)?.InviteCode || true;
    }
    return false;
};

export const removePartyCode = async (id, account, partyId) => {
    const auth = await authUser(id, account);
    if (!auth.success) return false;
    const user = getUser(id, account);
    if (!user) return false;
    const base = glzUrl(user);
    const headers = { ...authHeaders(user), "Content-Type": "application/json" };
    const resp = await fetch(`${base}/parties/v1/parties/${partyId}/invitecode`, {
        method: "DELETE",
        headers
    });
    console.log(`[livegame] removePartyCode for ${partyId} on ${base} returned:`, resp.statusCode);
    return resp.statusCode === 200;
};

export const joinPartyByCode = async (id, account, inviteCode) => {
    const auth = await authUser(id, account);
    if (!auth.success) return { success: false, reason: "auth_failed", auth };
    const user = getUser(id, account);
    if (!user) return { success: false, reason: "no_user" };

    const cleanCode = String(inviteCode || "").trim();
    const base = glzUrl(user);
    const headers = authHeaders(user);
    const url = `${base}/parties/v1/players/joinbycode/${encodeURIComponent(cleanCode)}`;

    console.log(`[livegame] joinPartyByCode calling ${url} for user ${user.puuid}`);
    const resp = await fetch(url, {
        method: "POST",
        headers
    });

    const bodyJson = safeJson(resp.body);
    console.log(`[livegame] joinPartyByCode for ${cleanCode} on ${base} returned: status=${resp.statusCode}, body=`, resp.body);

    const isSuccess = resp.statusCode === 200 || resp.statusCode === 204;
    return {
        success: isSuccess,
        statusCode: resp.statusCode,
        errorCode: bodyJson?.errorCode || bodyJson?.errorCodeName || null,
        errorMessage: bodyJson?.message || null,
        data: bodyJson
    };
};

// ──────────────────────────────────────────────
// Agent endpoints
// ──────────────────────────────────────────────

export const selectAgent = async (id, account, matchId, agentId) => {
    const auth = await authUser(id, account);
    if (!auth.success) return false;
    const user = getUser(id, account);
    if (!user) return false;
    const base = glzUrl(user);
    const headers = authHeaders(user);

    const resp = await fetch(
        `${base}/pregame/v1/matches/${matchId}/select/${agentId}`,
        { method: "POST", headers }
    );
    return resp.statusCode === 200;
};

export const startQueue = async (id, account, partyId) => {
    const auth = await authUser(id, account);
    if (!auth.success) return false;
    const user = getUser(id, account);
    if (!user) return false;
    const base = glzUrl(user);
    const headers = authHeaders(user);
    const resp = await fetch(`${base}/parties/v1/parties/${partyId}/matchmaking/join`, { method: "POST", headers });
    return resp.statusCode === 200;
};

export const cancelQueue = async (id, account, partyId) => {
    const auth = await authUser(id, account);
    if (!auth.success) return false;
    const user = getUser(id, account);
    if (!user) return false;
    const base = glzUrl(user);
    const headers = authHeaders(user);
    const resp = await fetch(`${base}/parties/v1/parties/${partyId}/matchmaking/leave`, { method: "POST", headers });
    return resp.statusCode === 200;
};

export const changeQueue = async (id, account, partyId, queueId) => {
    const auth = await authUser(id, account);
    if (!auth.success) return false;
    const user = getUser(id, account);
    if (!user) return false;
    const base = glzUrl(user);
    const headers = authHeaders(user);

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
    if (!user) return [];
    const base = pdUrl(user);
    const headers = authHeaders(user);

    const req = await fetch(`${base}/store/v1/entitlements/${user.puuid}/01bb38e1-da47-4e6a-9b3d-945fe4655707`, { headers });
    let owned = [];
    if (req.statusCode === 200) {
        const json = safeJson(req.body);
        if (json?.Entitlements) {
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
 * Returns { success, state: "pregame", matchId, mapId, mapName, queueId, players }
 * or       { success, state: "not_in_pregame" }
 * or       { success: false, ... } on auth failure.
 */
export const getPreGameData = async (id, account = null, knownMatchId = undefined) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return { ...authResult, state: null };

    const user = getUser(id, account);
    if (!user) return { success: false, state: null };
    const base = glzUrl(user);
    const headers = authHeaders(user);

    // Passing a known match id skips the probe — that's what makes the poller's
    // "is agent select still running?" check a single request.
    const matchId = knownMatchId === undefined
        ? await probeState(user, "pregame", "MatchID")
        : knownMatchId;
    if (!matchId) return { success: true, state: "not_in_pregame" };

    // Fetch match data
    const matchResp = await fetch(
        `${base}/pregame/v1/matches/${matchId}`,
        { headers }
    );

    if (matchResp.statusCode !== 200) {
        return { success: true, state: "not_in_pregame" };
    }

    const matchJson = safeJson(matchResp.body);
    if (!matchJson) return { success: true, state: "not_in_pregame" };

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
    // "fortcollins" / "fortcollins_primaryasset" → "retake" (Retake mode asset name)
    const SLUG_ALIASES = {
        customgame: "custom",
        standard: "unrated",
        fortcollins: "retake",
        fortcollins_primaryasset: "retake",
        dodgeball_gamemode_primaryasset: "knockout",
    };
    const queueId = matchJson.MatchmakingData?.QueueID ?? matchJson.QueueID ?? SLUG_ALIASES[rawSlug] ?? rawSlug;

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
        matchTier: p.CompetitiveTier || p.SeasonalBadgeInfo?.Rank || 0,
        partyId: p.PartyID ?? p.PartyId ?? p.partyId ?? null,
        isLeader: p.IsPartyOwner ?? false,
    }));

    return {
        success: true,
        state: "pregame",
        matchId,
        mapId,
        mapName: resolveMapName(mapId),
        serverName,
        queueId,
        players: rawPlayers,
        userPuuid: user.puuid,
    };
};

// ──────────────────────────────────────────────
// In-game fetch
// ──────────────────────────────────────────────

/**
 * Fetch in-game data for a user.
 * Returns { success, state: "ingame", matchId, mapId, mapName, queueId, players, userTeamId }
 * or       { success, state: "not_in_game" }
 * or       { success: false, ... } on auth failure.
 */
export const getInGameData = async (id, account = null, knownMatchId = undefined) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return { ...authResult, state: null };

    const user = getUser(id, account);
    if (!user) return { success: false, state: null };
    const base = glzUrl(user);
    const headers = authHeaders(user);

    const matchId = knownMatchId === undefined
        ? await probeState(user, "core-game", "MatchID")
        : knownMatchId;
    if (!matchId) return { success: true, state: "not_in_game" };

    // Fetch match data
    const matchResp = await fetch(
        `${base}/core-game/v1/matches/${matchId}`,
        { headers }
    );

    if (matchResp.statusCode !== 200) {
        return { success: true, state: "not_in_game" };
    }

    const matchJson = safeJson(matchResp.body);
    if (!matchJson) return { success: true, state: "not_in_game" };

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
        selectionState: "locked",
        incognito: p.PlayerIdentity?.Incognito ?? false,
        accountLevel: p.PlayerIdentity?.AccountLevel ?? null,
        isHideAccountLevel: p.PlayerIdentity?.HideAccountLevel ?? false,
        matchTier: p.Tier || p.SeasonalBadgeInfo?.Rank || 0,
        partyId: p.PartyID ?? p.PartyId ?? p.partyId ?? null,
        isLeader: p.IsPartyOwner ?? false,
    }));

    return {
        success: true,
        state: "ingame",
        matchId,
        mapId,
        mapName: resolveMapName(mapId),
        serverName,
        queueId,
        players: rawPlayers,
        userTeamId,
        userPuuid: user.puuid,
    };
};

// ──────────────────────────────────────────────
// Bulk data fetchers
// ──────────────────────────────────────────────
const playerMmrCache = new Map();
const playerRecentMatchesCache = new Map();
// Read-through TTL. Ranks don't move mid-match, so this covers a whole
// /livegame session (incl. the 8s poller) without a single refetch.
const MMR_CACHE_TTL = 1000 * 60 * 15; // 15 minutes

/**
 * Read-through per-PUUID cache: serve fresh cache hits, fetch only the misses.
 * A failed fetch serves a stale entry if there is one and is retried next call
 * (deliberately not negative-cached — a transient 5xx shouldn't pin a player
 * to "Unranked" for the whole TTL).
 *
 * @param {Map}      cache    puuid → { data, ts }
 * @param {number}   ttl      freshness window in ms
 * @param {string[]} puuids
 * @param {Function} fetchOne (puuid) => Promise<data|null>  — null means "failed"
 * @param {Function} empty    () => data  fallback when there's nothing cached
 */
export const cachedByPuuid = async (cache, ttl, puuids, fetchOne, empty) => {
    const now = Date.now();
    const out = new Map();
    const toFetch = [];

    for (const puuid of puuids) {
        const hit = cache.get(puuid);
        if (hit && now - hit.ts < ttl) out.set(puuid, hit.data);
        else toFetch.push(puuid);
    }

    const results = await Promise.allSettled(toFetch.map(fetchOne));
    toFetch.forEach((puuid, i) => {
        const r = results[i];
        if (r.status === "fulfilled" && r.value != null) {
            cache.set(puuid, { data: r.value, ts: now });
            out.set(puuid, r.value);
        } else {
            out.set(puuid, cache.get(puuid)?.data ?? empty());
        }
    });
    return out;
};

/**
 * Batch-fetch MMR for a list of PUUIDs using the caller's auth.
 * Returns Map<puuid, parsedMMR>.
 */
const fetchPlayerMMRs = (user, puuids) => {
    const headers = authHeaders(user);
    const pd = pdUrl(user);

    return cachedByPuuid(playerMmrCache, MMR_CACHE_TTL, puuids,
        puuid => fetch(`${pd}/mmr/v1/players/${puuid}`, { headers })
            .then(r => {
                const raw = r.statusCode === 200 ? safeJson(r.body) : null;
                return raw ? parseMMRData(raw, currentSeasonId) : null;
            }),
        () => parseMMRData(null, currentSeasonId));
};

/**
 * Batch-fetch Riot IDs (GameName#TagLine) for a list of PUUIDs.
 * Returns Map<puuid, "GameName#Tag"> (or null for incognito/missing).
 */
const playerNameCache = new Map();
const NAME_CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours — Riot IDs change rarely

const fetchPlayerNames = async (user, puuids) => {
    // This is one batched PUT rather than a request per player, so it can't use
    // cachedByPuuid — but the same idea applies: only ask for the misses, and
    // skip the request entirely when there are none. That's what takes a
    // steady-state poll of an unchanged lobby down to zero name lookups.
    const now = Date.now();
    const out = new Map();
    const toFetch = [];
    for (const puuid of puuids) {
        const hit = playerNameCache.get(puuid);
        if (hit && now - hit.ts < NAME_CACHE_TTL) out.set(puuid, hit.data);
        else toFetch.push(puuid);
    }
    if (toFetch.length === 0) return out;

    const headers = { ...authHeaders(user), "Content-Type": "application/json" };
    const pd = pdUrl(user);

    try {
        const resp = await fetch(`${pd}/name-service/v2/players`, {
            method: "PUT",
            headers,
            body: JSON.stringify(toFetch),
        });
        if (resp.statusCode === 200) {
            const json = safeJson(resp.body);
            if (Array.isArray(json)) {
                for (const entry of json) {
                    if (entry.GameName) {
                        const name = `${entry.GameName}#${entry.TagLine}`;
                        playerNameCache.set(entry.Subject, { data: name, ts: now });
                        out.set(entry.Subject, name);
                    }
                }
            }
        }
    } catch (e) {
        console.error("[livegame] fetchPlayerNames failed:", e);
    }
    return out;
};

/**
 * Fetch last 3 competitive match results for a list of PUUIDs.
 * Returns Map<puuid, Array<"win" | "loss" | "tie">>
 */
const fetchPlayerRecentMatches = (user, puuids) => {
    const pd = pdUrl(user);
    const headers = authHeaders(user);

    return cachedByPuuid(playerRecentMatchesCache, MMR_CACHE_TTL, puuids,
        puuid => fetch(`${pd}/mmr/v1/players/${puuid}/competitiveupdates?startIndex=0&endIndex=3&queue=competitive`, { headers })
            .then(r => {
                const raw = r.statusCode === 200 ? safeJson(r.body) : null;
                if (!raw?.Matches) return null;
                return raw.Matches.slice(0, 3).map(m => {
                    if (m.RankedRatingEarned > 0 || m.TierAfterUpdate > m.TierBeforeUpdate) return "win";
                    if (m.RankedRatingEarned < 0 || m.TierAfterUpdate < m.TierBeforeUpdate) return "loss";
                    if (m.RankedRatingEarned === 0) return "tie";
                    return null;
                }).filter(Boolean);
            }),
        () => []);
};

const playerCombatStatsCache = new Map();
const COMBAT_STATS_CACHE_TTL = 1000 * 60 * 30; // 30 mins

/**
 * Fetch combat stats (ADR, K/D, Headshot %) for a list of PUUIDs.
 * Uses HenrikDev API when configured, falls back to Riot match details / MMR.
 * Returns Map<puuid, { adr, kd, hs }>.
 */
const NO_COMBAT_STATS = () => ({ adr: 0, kd: "0", hs: 0 });

const fetchPlayerCombatStats = (user, puuids) => {
    const vapi = getVAPI();
    const region = userRegion(user);

    return cachedByPuuid(playerCombatStatsCache, COMBAT_STATS_CACHE_TTL, puuids,
        async (puuid) => {
            let stats = null;

            // Strategy 1: HenrikDev API (if available)
            if (vapi) {
                try {
                    const matchRes = await vapi.getMatchesByPUUID({ puuid, region, filter: "competitive", size: 5 });
                    if (matchRes?.data && Array.isArray(matchRes.data) && matchRes.data.length > 0) {
                        let totalDamage = 0;
                        let totalRounds = 0;
                        let totalKills = 0;
                        let totalDeaths = 0;
                        let totalHeadshots = 0;
                        let totalBodyshots = 0;
                        let totalLegshots = 0;

                        for (const m of matchRes.data) {
                            if (currentSeasonId && m.metadata?.season_id && m.metadata.season_id.toLowerCase() !== currentSeasonId.toLowerCase()) {
                                continue;
                            }
                            const pObj = m.players?.all_players?.find(p => p.puuid === puuid);
                            if (pObj) {
                                const pStats = pObj.stats || {};
                                totalDamage += pObj.damage_made || pStats.damage || pObj.damage || 0;
                                totalKills += pStats.kills || pObj.kills || 0;
                                totalDeaths += pStats.deaths || pObj.deaths || 0;
                                totalHeadshots += pStats.headshots || pObj.headshots || 0;
                                totalBodyshots += pStats.bodyshots || pObj.bodyshots || 0;
                                totalLegshots += pStats.legshots || pObj.legshots || 0;
                                totalRounds += m.metadata?.rounds_played || 0;
                            }
                        }

                        if (totalRounds > 0) {
                            const totalShots = totalHeadshots + totalBodyshots + totalLegshots;
                            stats = {
                                adr: Math.round(totalDamage / totalRounds),
                                kd: (totalKills / Math.max(totalDeaths, 1)).toFixed(2),
                                hs: totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0,
                            };
                        }
                    }
                } catch (e) {
                    // Fallback to next strategy
                }
            }

            // Strategy 2: Riot PD match history & match details fallback
            if (!stats) {
                try {
                    const pd = pdUrl(user);
                    const headers = authHeaders(user);
                    const historyResp = await fetch(`${pd}/match-history/v1/history/${puuid}?startIndex=0&endIndex=5&queue=competitive`, { headers });
                    if (historyResp.statusCode === 200) {
                        const historyJson = safeJson(historyResp.body);
                        const matchIds = (historyJson?.History || []).slice(0, 5).map(h => h.MatchID).filter(Boolean);

                        if (matchIds.length > 0) {
                            let totalDamage = 0;
                            let totalRounds = 0;
                            let totalKills = 0;
                            let totalDeaths = 0;
                            let totalHeadshots = 0;
                            let totalBodyshots = 0;
                            let totalLegshots = 0;

                            const detailsResults = await Promise.allSettled(
                                matchIds.map(mid =>
                                    fetch(`${pd}/match-details/v1/matches/${mid}`, { headers })
                                        .then(r => r.statusCode === 200 ? safeJson(r.body) : null)
                                )
                            );

                            for (const res of detailsResults) {
                                if (res.status === "fulfilled" && res.value) {
                                    const match = res.value;
                                    if (currentSeasonId && match.matchInfo?.seasonId && match.matchInfo.seasonId.toLowerCase() !== currentSeasonId.toLowerCase()) {
                                        continue;
                                    }
                                    const playerObj = (match.players || []).find(p => p.subject === puuid);
                                    if (playerObj?.stats) {
                                        totalKills += playerObj.stats.kills || 0;
                                        totalDeaths += playerObj.stats.deaths || 0;
                                        totalRounds += playerObj.stats.roundsPlayed || (match.roundResults?.length || 0);
                                        for (const rd of (playerObj.roundDamage || [])) {
                                            totalDamage += rd.damage || 0;
                                        }
                                    }
                                    for (const rr of (match.roundResults || [])) {
                                        const pStats = (rr.playerStats || []).find(ps => ps.subject === puuid);
                                        for (const dmg of (pStats?.damage || [])) {
                                            if (!playerObj?.roundDamage || playerObj.roundDamage.length === 0) {
                                                totalDamage += dmg.damage || 0;
                                            }
                                            totalHeadshots += dmg.headshots || 0;
                                            totalBodyshots += dmg.bodyshots || 0;
                                            totalLegshots += dmg.legshots || 0;
                                        }
                                    }
                                }
                            }

                            if (totalRounds > 0) {
                                const totalShots = totalHeadshots + totalBodyshots + totalLegshots;
                                stats = {
                                    adr: Math.round(totalDamage / totalRounds),
                                    kd: (totalKills / Math.max(totalDeaths, 1)).toFixed(2),
                                    hs: totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0,
                                };
                            }
                        }
                    }
                } catch (e) {
                    // Fallback
                }
            }

            // "no competitive history" is a real answer, not a failure — return it
            // so it gets cached, otherwise every poll re-runs the 6-request fallback.
            return stats ?? NO_COMBAT_STATS();
        },
        NO_COMBAT_STATS);
};

// ──────────────────────────────────────────────
// Player enrichment
// ──────────────────────────────────────────────

/**
 * Enrich raw player objects with name, rank, agent, and level info.
 * modifies players in-place AND returns them.
 */
const enrichPlayers = async (id, account, rawPlayers) => {
    const user = getUser(id, account);
    const puuids = rawPlayers.map(p => p.puuid);

    // loadSeasons must finish first so that currentSeasonId (module-level) is
    // populated before fetchPlayerMMRs calls parseMMRData(raw, currentSeasonId).
    // Running them in parallel caused a race where every player appeared Unranked
    // on the first /livegame refresh while already in a match.
    const seasonMap = seasonsCache; // Pre-warmed by fetchLiveGame
    const [mmrMap, nameMap, recentMatchesMap, combatStatsMap] = await Promise.all([
        fetchPlayerMMRs(user, puuids),
        fetchPlayerNames(user, puuids),
        fetchPlayerRecentMatches(user, puuids),
        fetchPlayerCombatStats(user, puuids)
    ]);

    // Enrich each player
    const enriched = await Promise.all(rawPlayers.map(async (p, idx) => {
        const mmr = mmrMap.get(p.puuid);
        const name = nameMap.get(p.puuid) ?? null;
        const actualCurrentTier = mmr?.currentTier || p.matchTier || 0;
        const combatStats = combatStatsMap.get(p.puuid) ?? null;

        // Resolve agent and tier icons/names in parallel
        const [agentInfo, currentTierInfo, peakTierInfo] = await Promise.all([
            p.agentId ? resolveAgent(p.agentId) : Promise.resolve({ name: "Unknown", icon: null, role: null }),
            resolveTier(actualCurrentTier),
            resolveTier(mmr?.peakTier ?? 0),
        ]);

        // Level: always carry through; levelHidden flag lets the embed show "?"
        const level = p.accountLevel ?? null;
        const levelHidden = p.isHideAccountLevel ?? false;

        const isUserSelf = p.puuid === user.puuid;
        const shouldHideName = p.incognito && !isUserSelf;

        return {
            ...p,
            playerIndex: idx + 1,
            incognito: shouldHideName,
            riotId: name ?? p.puuid.slice(0, 8),
            partyId: p.partyId ?? null,
            isLeader: p.isLeader ?? false,
            // Agent
            agentName: p.agentId ? agentInfo.names : null,
            agentIcon: p.agentId ? agentInfo.icon : null,
            selectionState: p.selectionState ?? "",
            // Rank
            currentTier: actualCurrentTier,
            currentRR: mmr?.currentRR ?? 0,
            currentTierName: currentTierInfo.name,
            currentTierIcon: currentTierInfo.icon,
            isRankFallback: !mmr?.currentTier && p.matchTier > 0,
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
            // Combat stats
            adr: combatStats?.adr ?? null,
            kd: combatStats?.kd ?? null,
            hs: combatStats?.hs ?? null,
            // Level
            accountLevel: level,
            levelHidden,
            // Recent competitive match results (Array<"win" | "loss" | "tie">)
            recentMatches: recentMatchesMap.get(p.puuid) ?? [],
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
 *   { success: true, state: "pregame",  mapName, players: [{...enriched}] }
 *   { success: true, state: "ingame",   mapName, players: [{...enriched}],
 *                                       allyPlayers, enemyPlayers }
 */
/** Enrich + decorate a raw getInGameData result into a render-ready payload. */
const buildInGame = async (id, account, inGame) => {
    const enriched = await enrichPlayers(id, account, inGame.players);
    return {
        ...inGame,
        players: enriched,
        allyPlayers: enriched.filter(p => p.isAlly),
        enemyPlayers: enriched.filter(p => !p.isAlly),
        isSingleTeam: SINGLE_TEAM_QUEUES.has(inGame.queueId?.toLowerCase()),
        queueIcon: resolveQueueIcon(inGame.queueId),
    };
};

/** Enrich + decorate a raw getPreGameData result into a render-ready payload. */
const buildPreGame = async (id, account, preGame) => {
    const enriched = await enrichPlayers(id, account, preGame.players);
    return {
        ...preGame,
        players: enriched,
        allyPlayers: enriched,
        enemyPlayers: [],
        isSingleTeam: SINGLE_TEAM_QUEUES.has(preGame.queueId?.toLowerCase()),
        queueIcon: resolveQueueIcon(preGame.queueId),
    };
};

/** Returned by repollLiveGame when what's already on screen is still accurate. */
export const LIVEGAME_UNCHANGED = Symbol("livegame:unchanged");

/**
 * Cheap re-poll for a user the bot already believes is in `state`.
 *
 * The poller knows what it drew last time, so it doesn't need fetchLiveGame's
 * three probes and detail fetch — it only has to answer "is this still true?"
 * against the match or party it is already showing.
 *
 *   pregame → the refreshed, enriched match, so agent hovers and locks stay
 *             live and the stolen-agent check still has data to compare
 *   queuing → LIVEGAME_UNCHANGED while the party is still MATCHMAKING. Nothing
 *             on that embed moves until a match is found or the queue is
 *             cancelled, so there is nothing to redraw and we skip the edit.
 *
 * Returns null when the state has moved on; the caller then runs the full
 * fetchLiveGame to find out what it moved to.
 */
export const repollLiveGame = async (id, account, state, matchId) => {
    if (!matchId) return null;
    if (state !== "pregame" && state !== "queuing") return null;

    const auth = await authUser(id, account);
    if (!auth.success) return null;
    const user = getUser(id, account);
    if (!user) return null;

    await Promise.all([loadAgents(), loadCompetitiveTiers(), loadMapNames(), loadSeasons(), loadGamemodes()]);

    if (state === "pregame") {
        // Probe core-game alongside the pregame read rather than inferring the
        // transition from a 404. Catching "the match started" is the poller's
        // entire job, so it shouldn't rest on how Riot expires pregame data.
        const [coreMatchId, preGame] = await Promise.all([
            probeState(user, "core-game", "MatchID"),
            getPreGameData(id, account, matchId),
        ]);
        if (coreMatchId) return null;                                   // in game now
        if (!preGame.success || preGame.state !== "pregame") return null; // dodged / ended
        return await buildPreGame(id, account, preGame);
    }

    if (state === "queuing") {
        // One request: the party id is the matchId we're already displaying.
        // Covers both transitions — a match being found and the queue being
        // cancelled from the game client both drop State out of MATCHMAKING.
        const resp = await fetch(`${glzUrl(user)}/parties/v1/parties/${matchId}`, { headers: authHeaders(user) });
        const stillQueuing = resp.statusCode === 200 && safeJson(resp.body)?.State === "MATCHMAKING";
        return stillQueuing ? LIVEGAME_UNCHANGED : null;
    }

    return null;
};

export const fetchLiveGame = async (id, account = null) => {
    // 1. Ensure static caches are ready before the parallel API calls
    await Promise.all([loadAgents(), loadCompetitiveTiers(), loadMapNames(), loadSeasons(), loadGamemodes()]);

    const authResult = await authUser(id, account);
    if (!authResult.success) return { ...authResult, state: null };

    const user = getUser(id, account);
    if (!user) return { success: false, state: null };

    // 2. One round trip for all three "am I in X?" probes, then only the state
    //    that actually hit pays for its detail fetch. They're mutually
    //    exclusive, so pulling party detail mid-match was always wasted.
    const [coreMatchId, preMatchId, partyId] = await Promise.all([
        probeState(user, "core-game", "MatchID"),
        probeState(user, "pregame", "MatchID"),
        probeState(user, "parties", "CurrentPartyID"),
    ]);

    if (coreMatchId) {
        const inGame = await getInGameData(id, account, coreMatchId);
        if (!inGame.success) return inGame;
        if (inGame.state === "ingame") return await buildInGame(id, account, inGame);
    }

    if (preMatchId) {
        const preGame = await getPreGameData(id, account, preMatchId);
        if (!preGame.success) return preGame;
        if (preGame.state === "pregame") return await buildPreGame(id, account, preGame);
    }

    const party = await getPartyData(id, account, partyId);
    if (!party.success) return party;

    if (party.state === "queuing" || party.state === "not_queuing") {
        let enriched = [];
        if (party.members && party.members.length > 0) {
            enriched = await enrichPlayers(id, account, party.members);
        }

        if (party.state === "queuing") {
            return {
                success: true,
                state: "queuing",
                matchId: party.matchId,
                queueId: party.queueId,
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
