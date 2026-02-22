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
    `https://glz-${userRegion(user)}-1.${user.region}.a.pvp.net`;

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

/** Fetch all playable agents once and cache them (keyed by lower-case UUID). */
const loadAgents = async () => {
    if (agentsCache) return;
    try {
        const req = await fetch("https://valorant-api.com/v1/agents?isPlayableCharacter=true");
        const json = JSON.parse(req.body);
        agentsCache = {};
        for (const agent of json.data) {
            agentsCache[agent.uuid.toLowerCase()] = {
                name: agent.displayName,
                icon: agent.displayIcon,
                role: agent.role?.displayName ?? null,
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
                    : tier.tierName.replace("_", " "),   // e.g. "GOLD 3"
                color: "#" + (tier.color ?? "000000").slice(0, 6),
                icon: tier.largeIcon ?? tier.smallIcon ?? null,
            };
        }
    } catch (e) {
        console.error("[livegame] Failed to load competitive tiers:", e);
        competitiveTiersCache = {};
    }
};

/** Invalidate static caches (call when skins/version reloads). */
export const clearLiveGameCache = () => {
    agentsCache = null;
    competitiveTiersCache = null;
};

/** Resolve agent UUID → {name, icon, role} */
export const resolveAgent = async (uuid) => {
    await loadAgents();
    return agentsCache[uuid?.toLowerCase()] ?? { name: "Unknown Agent", icon: null, role: null };
};

/** Resolve tier number (0-27) → {name, color, icon} */
export const resolveTier = async (tier) => {
    await loadCompetitiveTiers();
    if (!tier || tier === 0) return { name: "Unranked", color: "#000000", icon: null };
    return competitiveTiersCache[tier] ?? { name: "Unranked", color: "#000000", icon: null };
};

// ──────────────────────────────────────────────
// Map ID → display name
// ──────────────────────────────────────────────

const MAP_NAMES = {
    "/Game/Maps/Ascent/Ascent":                     "Ascent",
    "/Game/Maps/Bonsai/Bonsai":                     "Split",
    "/Game/Maps/Canyon/Canyon":                     "Fracture",
    "/Game/Maps/Duality/Duality":                   "Bind",
    "/Game/Maps/Foxtrot/Foxtrot":                   "Breeze",
    "/Game/Maps/Port/Port":                         "Icebox",
    "/Game/Maps/Triad/Triad":                       "Haven",
    "/Game/Maps/Pitt/Pitt":                          "Pearl",
    "/Game/Maps/Jam/Jam":                           "Lotus",
    "/Game/Maps/Juliett/Juliett":                   "Sunset",
    "/Game/Maps/HURM/HURM_Alley/HURM_Alley":        "District",
    "/Game/Maps/HURM/HURM_Bowl/HURM_Bowl":          "Kasbah",
    "/Game/Maps/HURM/HURM_Helix/HURM_Helix":        "Drift",
    "/Game/Maps/HURM/HURM_Yard/HURM_Yard":          "Glitch",
    "/Game/Maps/Arena/Arena":                       "The Range",
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
let mapNamesCache  = null;  // populated alongside images

const loadMapImages = async () => {
    if (mapImagesCache) return;
    try {
        const req  = await fetch("https://valorant-api.com/v1/maps");
        const json = JSON.parse(req.body);
        mapImagesCache = {};
        mapNamesCache  = {};
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
        mapNamesCache  = {};
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
            for (const s of data) {
                if (s.type === "EAresSeasonType::Act") {
                    const label = actLabelFromPath(s.assetPath);
                    if (label) seasonsCache.set(s.uuid, label);
                }
            }
        }
    } catch (e) {
        console.error("[livegame] loadSeasons failed:", e);
    }
    return seasonsCache;
};

// ──────────────────────────────────────────────
// Queue ID → display name
// ──────────────────────────────────────────────

const QUEUE_NAMES = {
    competitive:  "Competitive",
    unrated:      "Unrated",
    spikerush:    "Spike Rush",
    deathmatch:   "Deathmatch",
    ggteam:       "Escalation",
    onefa:        "Replication",
    custom:       "Custom",
    snowball:     "Snowball Fight",
    swiftplay:    "Swift Play",
    hurm:         "Team Deathmatch",
    valaram:      "ARAM",
    newmap:       "New Map",
    "":           "Custom",
};

export const resolveQueueName = (queueId) =>
    QUEUE_NAMES[queueId?.toLowerCase()] ?? (queueId ?? "Unknown Mode");

/**
 * Queue ID → game mode display icon URL (from valorant-api.com/v1/gamemodes).
 * UUIDs are stable across patches; only add new rows when a new queue ships.
 */
const QUEUE_ICONS = {
    competitive:  "https://media.valorant-api.com/gamemodes/96bd3920-4f36-d026-2b28-c683eb0bcac5/displayicon.png",
    unrated:      "https://media.valorant-api.com/gamemodes/96bd3920-4f36-d026-2b28-c683eb0bcac5/displayicon.png",
    spikerush:    "https://media.valorant-api.com/gamemodes/e921d1e6-416b-c31f-1291-74930c330b7b/displayicon.png",
    deathmatch:   "https://media.valorant-api.com/gamemodes/a8790ec5-4237-f2f0-e93b-08a8e89865b2/displayicon.png",
    ggteam:       "https://media.valorant-api.com/gamemodes/a4ed6518-4741-6dcb-35bd-f884aecdc859/displayicon.png",
    onefa:        "https://media.valorant-api.com/gamemodes/4744698a-4513-dc96-9c22-a9aa437e4a58/displayicon.png",
    snowball:     "https://media.valorant-api.com/gamemodes/57038d6d-49b1-3a74-c5ef-3395d9f23a97/displayicon.png",
    swiftplay:    "https://media.valorant-api.com/gamemodes/5d0f264b-4ebe-cc63-c147-809e1374484b/displayicon.png",
    hurm:         "https://media.valorant-api.com/gamemodes/e086db66-47fd-e791-ca81-06a645ac7661/displayicon.png",
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
export const parseMMRData = (mmrJson) => {
    const empty = { currentTier: 0, currentRR: 0, peakTier: 0, wins: 0, games: 0, winRate: null };
    if (!mmrJson) return empty;

    // Current rank — best source is the latest competitive update
    const latest = mmrJson.LatestCompetitiveUpdate;
    let currentTier = latest?.TierAfterUpdate ?? 0;
    let currentRR   = 0;

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

    // Get wins/games from the season of the latest update
    if (latest?.SeasonID && seasonal[latest.SeasonID]) {
        wins  = seasonal[latest.SeasonID].NumberOfWinsWithPlacements ?? 0;
        games = seasonal[latest.SeasonID].NumberOfGames ?? 0;
    }

    const winRate = games > 0 ? Math.round((wins / games) * 100) : null;

    return { currentTier, currentRR, peakTier, peakSeasonId, wins, games, winRate };
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

    const mapId    = matchJson.MapID ?? "";
    const queueId  = matchJson.GameConfig?.GameMode?.toLowerCase()
        .replace("https://valorant.playvalorant.com/json_documents/modes/", "")
        .replace(".json", "") ?? "";

    const rawPlayers = (matchJson.AllyTeam?.Players ?? []).map((p, idx) => ({
        puuid:    p.Subject,
        teamId:   "Ally",
        isAlly:   true,
        allyIndex: idx + 1,
        agentId:  p.CharacterID ?? null,
        incognito: p.PlayerIdentity?.Incognito ?? false,
        accountLevel: p.PlayerIdentity?.AccountLevel ?? null,
        isHideAccountLevel: p.PlayerIdentity?.HideAccountLevel ?? false,
    }));

    return {
        success: true,
        state:     "pregame",
        matchId,
        mapId,
        mapName:   resolveMapName(mapId),
        queueId,
        queueName: resolveQueueName(queueId),
        players:   rawPlayers,
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

    const mapId       = matchJson.MapID ?? "";
    const queueId     = matchJson.MatchmakingData?.QueueID ?? "";
    const userTeamId  = matchJson.Players
        .find(p => p.Subject === user.puuid)?.TeamID ?? null;

    const rawPlayers = matchJson.Players.map((p, idx) => ({
        puuid:    p.Subject,
        teamId:   p.TeamID,
        isAlly:   p.TeamID === userTeamId,
        allyIndex: idx + 1,
        agentId:  p.CharacterID ?? null,
        incognito: p.PlayerIdentity?.Incognito ?? false,
        accountLevel: p.PlayerIdentity?.AccountLevel ?? null,
        isHideAccountLevel: p.PlayerIdentity?.HideAccountLevel ?? false,
    }));

    return {
        success:    true,
        state:      "ingame",
        matchId,
        mapId,
        mapName:    resolveMapName(mapId),
        queueId,
        queueName:  resolveQueueName(queueId),
        players:    rawPlayers,
        userTeamId,
        userPuuid:  user.puuid,
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
    const pd      = pdUrl(user);

    const results = await Promise.allSettled(
        puuids.map(puuid =>
            fetch(`${pd}/mmr/v1/players/${puuid}`, { headers })
                .then(r => r.statusCode === 200 ? JSON.parse(r.body) : null)
        )
    );

    const out = new Map();
    for (let i = 0; i < puuids.length; i++) {
        const raw = results[i].status === "fulfilled" ? results[i].value : null;
        out.set(puuids[i], parseMMRData(raw));
    }
    return out;
};

/**
 * Batch-fetch Riot IDs (GameName#TagLine) for a list of PUUIDs.
 * Returns Map<puuid, "GameName#Tag"> (or null for incognito/missing).
 */
const fetchPlayerNames = async (user, puuids) => {
    const headers = { ...authHeaders(user), "Content-Type": "application/json" };
    const pd      = pdUrl(user);

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
 * Fetch the last 3 competitive match results for a single PUUID.
 * Returns an array of { win: boolean } — most-recent first.
 * Uses RankedRatingEarned > 0 as the win heuristic.
 */
const fetchCompetitiveUpdates = async (user, puuid) => {
    const pd      = pdUrl(user);
    const headers = authHeaders(user);
    try {
        const resp = await fetch(
            `${pd}/mmr/v1/players/${puuid}/competitiveupdates?startIndex=0&endIndex=3&queue=competitive`,
            { headers }
        );
        if (resp.statusCode !== 200) return [];
        const json = JSON.parse(resp.body);
        return (json.Matches ?? []).slice(0, 3).map(m => ({
            win: (m.RankedRatingEarned ?? 0) > 0,
        }));
    } catch {
        return [];
    }
};

// ──────────────────────────────────────────────
// Player enrichment
// ──────────────────────────────────────────────

/**
 * Enrich raw player objects with name, rank, agent, and level info.
 * modifies players in-place AND returns them.
 */
const enrichPlayers = async (id, account, rawPlayers, queueId = "") => {
    const user    = getUser(id, account);
    const puuids  = rawPlayers.map(p => p.puuid);
    const isComp  = queueId === "competitive";

    // Start all parallel fetches (including season labels)
    const [mmrMap, nameMap, seasonMap] = await Promise.all([
        fetchPlayerMMRs(user, puuids),
        fetchPlayerNames(user, puuids.filter(p => !rawPlayers.find(rp => rp.puuid === p)?.incognito)),
        loadSeasons(),
    ]);

    // Competitive updates — one request per player, run in parallel
    const compUpdatesMap = new Map();
    if (isComp) {
        const results = await Promise.allSettled(
            puuids.map(puuid => fetchCompetitiveUpdates(user, puuid))
        );
        for (let i = 0; i < puuids.length; i++) {
            compUpdatesMap.set(
                puuids[i],
                results[i].status === "fulfilled" ? results[i].value : []
            );
        }
    }

    // Enrich each player
    const enriched = await Promise.all(rawPlayers.map(async (p, idx) => {
        const mmr   = mmrMap.get(p.puuid);
        const name  = !p.incognito ? (nameMap.get(p.puuid) ?? null) : null;

        // Resolve agent and tier icons/names in parallel
        const [agentInfo, currentTierInfo, peakTierInfo] = await Promise.all([
            p.agentId ? resolveAgent(p.agentId) : Promise.resolve({ name: "Unknown", icon: null, role: null }),
            resolveTier(mmr?.currentTier ?? 0),
            resolveTier(mmr?.peakTier    ?? 0),
        ]);

        // Level: always carry through; levelHidden flag lets the embed show "?"
        const level = p.accountLevel ?? null;
        const levelHidden = p.isHideAccountLevel ?? false;

        return {
            ...p,
            // Identity: incognito players show their agent name once it's
            // locked; "Player N" is only the fallback for pre-game (no agent yet).
            riotId:    p.incognito
                ? (agentInfo.name !== "Unknown" && p.agentId ? agentInfo.name : `Player ${idx + 1}`)
                : (name ?? p.puuid.slice(0, 8)),
            // Agent
            agentName: p.agentId  ? agentInfo.name : null,
            agentIcon: p.agentId  ? agentInfo.icon : null,
            // Rank
            currentTier:     mmr?.currentTier   ?? 0,
            currentRR:       mmr?.currentRR     ?? 0,
            currentTierName: currentTierInfo.name,
            currentTierIcon: currentTierInfo.icon,
            // Peak rank
            peakTier:        mmr?.peakTier      ?? 0,
            peakTierName:    peakTierInfo.name,
            peakTierIcon:    peakTierInfo.icon,
            peakActLabel:    seasonMap.get(mmr?.peakSeasonId ?? "") ?? null,
            // Win stats
            wins:      mmr?.wins    ?? 0,
            games:     mmr?.games   ?? 0,
            winRate:   mmr?.winRate ?? null,
            // Level
            accountLevel: level,
            levelHidden,
            // Recent competitive match results ([] if not competitive)
            recentMatches: compUpdatesMap.get(p.puuid) ?? [],
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
    await Promise.all([loadAgents(), loadCompetitiveTiers(), loadMapImages(), loadSeasons()]);

    // 2. Try in-game
    const inGame = await getInGameData(id, account);
    if (!inGame.success) return inGame;  // auth failure

    if (inGame.state === "ingame") {
        const enriched = await enrichPlayers(id, account, inGame.players, inGame.queueId);
        const allyPlayers   = enriched.filter(p => p.isAlly);
        const enemyPlayers  = enriched.filter(p => !p.isAlly);
        const mapImage      = await resolveMapImage(inGame.mapId);
        const isSingleTeam  = SINGLE_TEAM_QUEUES.has(inGame.queueId?.toLowerCase());
        const queueIcon     = resolveQueueIcon(inGame.queueId);
        return { ...inGame, players: enriched, allyPlayers, enemyPlayers, mapImage, isSingleTeam, queueIcon };
    }

    // 3. Try pre-game
    const preGame = await getPreGameData(id, account);
    if (!preGame.success) return preGame;

    if (preGame.state === "pregame") {
        const enriched = await enrichPlayers(id, account, preGame.players, preGame.queueId);
        const mapImage     = await resolveMapImage(preGame.mapId);
        const isSingleTeam = SINGLE_TEAM_QUEUES.has(preGame.queueId?.toLowerCase());
        const queueIcon    = resolveQueueIcon(preGame.queueId);
        return { ...preGame, players: enriched, allyPlayers: enriched, enemyPlayers: [], mapImage, isSingleTeam, queueIcon };
    }

    // 4. Not in any game
    return { success: true, state: "not_in_game" };
};
