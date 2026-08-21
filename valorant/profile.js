import config from "../misc/config.js";
import unofficialValorantApi from "unofficial-valorant-api";
let VAPI;
const getVAPI = () => {
    if (!VAPI && config.HDevToken) VAPI = new unofficialValorantApi(config.HDevToken);
    return VAPI;
}
import { ordinalSuffix, fetch, userRegion, riotClientHeaders } from "../misc/util.js";
import { s } from "../misc/languages.js";
import { authUser, getUser } from "./auth.js";

export const getAccountXP = async (user, account = null) => {
    if (!user) return null;
    try {
        const authResult = await authUser(user.id, account);
        if (!authResult.success) return null;
        const uAuthed = getUser(user.id, account);
        if (!uAuthed?.auth?.rso) return null;
        const region = userRegion(uAuthed);
        const res = await fetch(`https://pd.${region}.a.pvp.net/account-xp/v1/players/${uAuthed.puuid}`, {
            headers: {
                "Authorization": "Bearer " + uAuthed.auth.rso,
                "X-Riot-Entitlements-JWT": uAuthed.auth.ent,
                ...riotClientHeaders(),
            }
        });
        if (res.statusCode === 200) {
            const json = JSON.parse(res.body);
            if (json.Progress) {
                return {
                    level: json.Progress.Level,
                    xp: json.Progress.XP,
                    maxXP: 5000
                };
            }
        }
    } catch (e) {
        console.error("Failed to fetch account XP:", e);
    }
    return null;
};

const xCache = { account: {}, matches: {} }
const getCache = (user, type) => {
    if (user.puuid in xCache[type]) {
        const cached = xCache[type][user.puuid];
        const expiresIn = cached.timestamp - Date.now() + config.careerCacheExpiration;
        if (expiresIn <= 0) {
            delete xCache[type][user.puuid];
            return { success: false };
        } else {
            console.log(`Fetched ${type} from cache for user ${user.username}! It expires in ${Math.ceil(expiresIn / 1000)}s.`);
            return { success: true, data: cached.data };
        }
    }
    return { success: false };
}

const progressCache = { acc: {}, mmr: {}, matches: {}, mmrHistory: {} }
const progress = (user, type, shouldBeDeleted = false) => {
    if (shouldBeDeleted) {
        delete progressCache[type][user.puuid];
        return;
    }
    const inProg = Boolean(progressCache[type][user.puuid]);
    progressCache[type][user.puuid] = true;
    return inProg;
}

export const TIER_NAMES = [
    "Unranked", "Unranked", "Unranked",
    "Iron 1", "Iron 2", "Iron 3",
    "Bronze 1", "Bronze 2", "Bronze 3",
    "Silver 1", "Silver 2", "Silver 3",
    "Gold 1", "Gold 2", "Gold 3",
    "Platinum 1", "Platinum 2", "Platinum 3",
    "Diamond 1", "Diamond 2", "Diamond 3",
    "Ascendant 1", "Ascendant 2", "Ascendant 3",
    "Immortal 1", "Immortal 2", "Immortal 3",
    "Radiant"
];

export const getAccountInfo = async (user, interaction) => {
    if (!getVAPI()) return { success: false, error: "API client is not initialized yet. Please try again in a moment." };
    let cache = getCache(user, 'account');
    if (cache.success) return cache;
    if (progress(user, 'acc') || progress(user, 'mmr')) return { success: false, error: s(interaction).error.WAIT_FOR_PREVIUS_REQUEST }

    let accountData = await getVAPI().getAccountByPUUID({ puuid: user.puuid, force: true });
    console.log(`Checked ACCData for ${user.id} R:${accountData?.ratelimits?.remaining} Reset: in ${accountData?.ratelimits?.reset} seconds`)

    // Catch forced-fetch errors regarding "Level and more data" -> retry without forcing
    const accErr = String(accountData.error?.[0]?.message || accountData.error || "");
    if (accErr.includes("fetching needed match data")) {
        console.log(`Account fetch forced error for ${user.id}, retrying without force...`);
        accountData = await getVAPI().getAccountByPUUID({ puuid: user.puuid, force: false });
        console.log(`Retry ACCData for ${user.id} R:${accountData?.ratelimits?.remaining} Reset: in ${accountData?.ratelimits?.reset} seconds`)
    }

    const mmrData = await getVAPI().getMMRByPUUID({ version: "v2", region: user.region, puuid: user.puuid });
    console.log(`Checked MMRData for ${user.id} R:${mmrData?.ratelimits?.remaining} Reset: in ${mmrData?.ratelimits?.reset} seconds`)

    setTimeout(() => {
        progress(user, 'acc', true);
        progress(user, 'mmr', true);
    }, 1000);

    let err = accountData.error || mmrData.error
    if (err) return { success: false, error: Array.isArray(err) ? err[0].message : err };

    const currentData = mmrData?.data?.current_data || {};
    const highestRank = mmrData?.data?.highest_rank || {};

    const resolvedCurrentTier = currentData.currenttier_patched
        || currentData.currenttierpatched
        || (currentData.currenttier != null ? TIER_NAMES[currentData.currenttier] : null)
        || "Unranked";

    const resolvedPeakTier = highestRank.patched_tier
        || highestRank.patchedtier
        || (highestRank.tier != null ? TIER_NAMES[highestRank.tier] : null)
        || "Unranked";

    currentData.currenttier_patched = resolvedCurrentTier;
    highestRank.patched_tier = resolvedPeakTier;

    const mmr = { current_data: currentData, highest_rank: highestRank };
    const data = { account: accountData.data, mmr: mmr };

    xCache["account"][user.puuid] = { data: data, timestamp: Date.now() };
    return { success: true, data: data };
}

export const fetchMatchHistory = async (interaction, user) => {
    if (!getVAPI()) return { success: false, error: "API client is not initialized yet. Please try again in a moment." };
    let cache = getCache(user, 'matches');
    if (cache.success) return cache;

    if (progress(user, 'matches') || progress(user, 'mmrHistory')) return { success: false, error: s(interaction).error.WAIT_FOR_PREVIUS_REQUEST }
    const matchHistory = await getVAPI().getMatchesByPUUID({ puuid: user.puuid, region: user.region, filter: "competitive", size: 20 });
    console.log(`Checked match history for ${user.id} R:${matchHistory?.ratelimits?.remaining} Reset: in ${matchHistory?.ratelimits?.reset} seconds`)
    setTimeout(() => { progress(user, 'matches', true); }, 5000);
    if (matchHistory.error) return { success: false, error: Array.isArray(matchHistory.error) ? matchHistory.error[0].message : matchHistory.error };
    else if (!matchHistory.data || matchHistory.data.length === 0) return { success: false, error: s(interaction).error.NO_MATCH_DATA.f({ m: "competitive" }) };

    const mmrHistory = await getVAPI().getMMRHistoryByPUUID({ puuid: user.puuid, region: user.region });
    console.log(`Checked MMRHistory for ${user.id} R:${mmrHistory?.ratelimits?.remaining} Reset: in ${mmrHistory?.ratelimits?.reset} seconds`)
    setTimeout(() => { progress(user, 'mmrHistory', true); }, 1000);
    if (mmrHistory.error) return { success: false, error: Array.isArray(mmrHistory.error) ? mmrHistory.error[0].message : mmrHistory.error };
    const matches = [];

    for (let i = 0; i < matchHistory.data.length; i++) {
        const match = matchHistory.data[i];

        // Skip matches with incomplete data
        if (!match?.metadata || !match?.players?.all_players || !match?.teams) {
            console.log(`Skipping match ${i} due to incomplete data`);
            continue;
        }

        // Strictly filter by mode to prevent Team Deathmatch bleeding into Competitive
        if (match.metadata.mode && match.metadata.mode.toLowerCase() !== "competitive") {
            console.log(`Skipping match ${i} - mode mismatch (expected competitive, got ${match.metadata.mode})`);
            continue;
        }

        // Skip matches older than 1 month
        const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
        const gameStartMs = (match.metadata.game_start ?? 0) * 1000;
        if (gameStartMs > 0 && Date.now() - gameStartMs > ONE_MONTH_MS) {
            console.log(`Skipping match ${i} - older than 1 month`);
            continue;
        }

        const rounds = match.metadata.rounds_played > 0 ? match.metadata.rounds_played : 1;
        const data = { metadata: {}, player: {} };
        const matchMMR = mmrHistory.data?.find(item => item.match_id === match.metadata.matchid);
        const player = match.players.all_players.find(p => p.puuid === user.puuid);

        // Skip if player not found in match
        if (!player?.stats || !player?.assets || !player?.team) {
            console.log(`Skipping match ${i} - player data not found`);
            continue;
        }

        const playerPosition = match.players.all_players.slice().sort((a, b) => b.stats.score - a.stats.score).findIndex(p => p.puuid === user.puuid) + 1;

        const totalShots = player.stats.headshots + player.stats.bodyshots + player.stats.legshots;
        data.player.hs_percent = totalShots > 0
            ? Math.ceil(player.stats.headshots / totalShots * 100)
            : 0;
        data.player.average_damage_round = ((player.damage_made ?? 0) / rounds).toFixed(1);
        data.player.average_combat_score = (player.stats.score / rounds).toFixed(1);
        data.player.agent = { name: player.character, iconUrl: player.assets.agent.small };
        data.player.kills = player.stats.kills;
        data.player.deaths = player.stats.deaths;
        data.player.assists = player.stats.assists;
        data.player.kd = (player.stats.kills / (player.stats.deaths || 1)).toFixed(2);
        data.player.position = `${playerPosition}${ordinalSuffix(playerPosition)}`;
        data.player.team = player.team;
        data.metadata.map = match.metadata.map;
        data.metadata.game_start = match.metadata.game_start;
        data.metadata.game_length = match.metadata.game_length;

        const playerTeamKey = player.team ? player.team.toLowerCase() : "blue";
        const enemyTeamKey = playerTeamKey === "blue" ? "red" : "blue";
        const teamData = match.teams ? match.teams[playerTeamKey] : null;
        const enemyTeamData = match.teams ? match.teams[enemyTeamKey] : null;

        data.metadata.pt_round_won = teamData?.rounds_won ?? null;
        data.metadata.et_round_won = teamData?.rounds_lost ?? (enemyTeamData?.rounds_won ?? null);

        if (teamData?.has_won === true) {
            data.player.has_won = true;
            data.player.is_draw = false;
        } else if (enemyTeamData?.has_won === true) {
            data.player.has_won = false;
            data.player.is_draw = false;
        } else {
            const isTie = data.metadata.pt_round_won != null && data.metadata.pt_round_won === data.metadata.et_round_won;
            data.player.is_draw = isTie;
            data.player.has_won = !isTie && (data.metadata.pt_round_won > data.metadata.et_round_won);
        }

        if (matchMMR) {
            data.player.mmr = matchMMR.mmr_change_to_last_game;
            if (typeof data.player.mmr === "number" && data.player.mmr > 0) data.player.mmr = `+${data.player.mmr}`;
            data.player.currentTierImageUrl = matchMMR.images?.large || matchMMR.images?.small;
            data.player.currenttier_patched = matchMMR.currenttier_patched
                || matchMMR.currenttierpatched
                || (matchMMR.tier != null ? TIER_NAMES[matchMMR.tier] : null)
                || (matchMMR.currenttier != null ? TIER_NAMES[matchMMR.currenttier] : null)
                || "Unranked";
            data.player.ranking_in_tier = matchMMR.ranking_in_tier;
        }
        matches.push(data);
    }
    if (matches.length === 0) return { success: false, error: s(interaction).error.NO_MATCH_DATA.f({ m: "competitive" }) };
    const data = { success: true, data: matches, timestamp: Date.now() };
    xCache["matches"][user.puuid] = data;
    return { success: true, data: matches };
};
