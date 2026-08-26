import { authUser, handleBadClaims, getUser } from "./auth.js";
import { fetch, isMaintenance, riotClientHeaders, safeJson, userRegion } from "../misc/util.js";
import { getBattlepassInfo, getBuddy, getCard, getFlex, getSkin, getSpray, getValorantVersion } from "./cache.js";
import { getItemEntitlements } from "./inventory.js";
import { l, s } from "../misc/languages.js";

const AVERAGE_UNRATED_XP_CONSTANT = 4200;
const SPIKERUSH_XP_CONSTANT = 1000;
const LEVEL_MULTIPLIER = 750;

const getWeeklies = async () => {
    try {
        const req = await fetch("https://valorant-api.com/v1/missions");
        const json = safeJson(req.body);

        const now = Date.now();
        const weeklyData = {};
        if (Array.isArray(json?.data)) {
            json.data.forEach(mission => {
                if (mission.type === "EAresMissionType::Weekly" && new Date(mission.expirationDate) > now) {
                    if (!weeklyData[mission.activationDate]) {
                        weeklyData[mission.activationDate] = {};
                    }
                    weeklyData[mission.activationDate][mission.uuid] = {
                        title: mission.title,
                        xpGrant: mission.xpGrant,
                        progressToComplete: mission.progressToComplete,
                        activationDate: mission.activationDate
                    };
                }
            });
        }
        return weeklyData;
    } catch (e) {
        console.error("Failed to fetch missions:", e);
        return {};
    }
};

const calculate_level_xp = async (level) => {
    if (level >= 2 && level <= 50) {
        return 2000 + (level - 2) * LEVEL_MULTIPLIER;
    } else if (level >= 51 && level <= 55) {
        return 36500;
    } else {
        return 0;
    }
};

const getNextReward = async (interaction, currentTier) => {
    if (currentTier >= 55) {
        return {
            tier: 56,
            rewardName: s(interaction).battlepass.FINISHED,
            rewardIcon: null,
            rewardType: "Finished",
            XP: 0
        };
    }

    const battlepassInfo = await getBattlepassInfo();
    if (!battlepassInfo || !Array.isArray(battlepassInfo.chapters)) return null;

    const allLevels = battlepassInfo.chapters.flatMap(chapter => chapter.levels || []);
    const nextTier = allLevels[currentTier];
    if (!nextTier || !nextTier.reward) return null;

    const rewardType = nextTier.reward.type;
    const rewardUUID = nextTier.reward.uuid;
    const xpAmount = nextTier.xp;

    switch (rewardType) {
        case "EquippableSkinLevel": {
            const skin = await getSkin(rewardUUID);
            return {
                tier: currentTier + 1,
                rewardName: skin ? l(skin.names, interaction) : "Skin",
                rewardIcon: skin?.icon || null,
                rewardType: rewardType,
                XP: xpAmount
            };
        }
        case "EquippableCharmLevel": {
            const buddy = await getBuddy(rewardUUID);
            return {
                tier: currentTier + 1,
                rewardName: buddy ? l(buddy.names, interaction) : "Buddy",
                rewardIcon: buddy?.icon || null,
                rewardType: rewardType,
                XP: xpAmount
            };
        }
        case "Currency":
            return {
                tier: currentTier + 1,
                rewardName: s(interaction).info.RADIANITE,
                rewardIcon: 'https://media.valorant-api.com/currencies/e59aa87c-4cbf-517a-5983-6e81511be9b7/displayicon.png',
                rewardType: rewardType,
                XP: xpAmount
            };
        case "PlayerCard": {
            const card = await getCard(rewardUUID);
            return {
                tier: currentTier + 1,
                rewardName: card ? l(card.names, interaction) : "Card",
                rewardIcon: card?.icons?.small || null,
                rewardType: rewardType,
                XP: xpAmount
            };
        }
        case "Spray": {
            const spray = await getSpray(rewardUUID);
            return {
                tier: currentTier + 1,
                rewardName: spray ? l(spray.names, interaction) : "Spray",
                rewardIcon: spray?.icon || null,
                rewardType: rewardType,
                XP: xpAmount
            };
        }
        case "Totem": {
            const flex = await getFlex(rewardUUID);
            return {
                tier: currentTier + 1,
                rewardName: flex ? l(flex.names, interaction) : "Flex",
                rewardIcon: flex?.icon || null,
                rewardType: rewardType,
                XP: xpAmount
            };
        }
        default:
            return {
                tier: currentTier + 1,
                rewardName: "Reward",
                rewardIcon: null,
                rewardType: rewardType,
                XP: xpAmount
            };
    }
};

export const getBattlepassProgress = async (interaction, maxlevel = 50, targetId = interaction.user.id, _retried = false) => {
    const user = getUser(targetId);
    if (!user) return { success: false };

    const authSuccess = await authUser(targetId);
    if (!authSuccess.success) return authSuccess;

    const valUser = getUser(targetId);
    console.log(`Fetching battlepass progress for ${valUser.username}...`);

    let req;
    try {
        const clientVer = await getValorantVersion().catch(() => ({}));
        req = await fetch(`https://pd.${userRegion(valUser)}.a.pvp.net/contracts/v1/contracts/${valUser.puuid}`, {
            headers: {
                "Authorization": "Bearer " + valUser.auth.rso,
                "X-Riot-Entitlements-JWT": valUser.auth.ent,
                "X-Riot-ClientVersion": clientVer.riotClientVersion || "",
                ...riotClientHeaders(),
            }
        });
    } catch (e) {
        console.error("Error fetching contracts:", e);
        return { success: false };
    }

    const json = safeJson(req.body);
    if (!json) return { success: false };
    if (json.httpStatus === 400 && json.errorCode === "BAD_CLAIMS") {
        const result = await handleBadClaims(valUser);
        if (result.retry && !_retried) return await getBattlepassProgress(interaction, maxlevel, targetId, true);
        return result;
    } else if (isMaintenance(json)) {
        return { success: false, maintenance: true };
    }

    const battlepassInfo = await getBattlepassInfo();
    if (!battlepassInfo || !battlepassInfo.uuid) return { success: false, error: "Battlepass info unavailable" };

    const contract = json.Contracts && json.Contracts.find(c => c.ContractDefinitionID === battlepassInfo.uuid);
    if (!contract) return { success: false, error: "Active battlepass contract not found" };

    const contractData = {
        progressionLevelReached: contract.ProgressionLevelReached || 0,
        progressionTowardsNextLevel: contract.ProgressionTowardsNextLevel || 0,
        totalProgressionEarned: contract.ContractProgression ? contract.ContractProgression.TotalProgressionEarned : 0,
        missions: {
            missionArray: json.Missions || [],
            weeklyCheckpoint: json.MissionMetadata ? json.MissionMetadata.WeeklyCheckpoint : null
        }
    };

    const weeklyxp = await getWeeklyXP(contractData.missions);
    const isBpPurchased = await getBattlepassPurchase(targetId);

    const season_end = new Date(battlepassInfo.end);
    const season_now = Date.now();
    const season_left = Math.max(0, season_end - season_now);
    const season_days_left = Math.max(1, Math.floor(season_left / (1000 * 60 * 60 * 24)));
    const season_weeks_left = Math.max(1, season_days_left / 7);

    let totalxp = contractData.totalProgressionEarned;
    let totalxpneeded = 0;
    for (let i = 1; i <= maxlevel; i++) {
        totalxpneeded += await calculate_level_xp(i);
    }
    totalxpneeded -= totalxp;

    let spikerush_xp = SPIKERUSH_XP_CONSTANT;
    let average_unrated_xp = AVERAGE_UNRATED_XP_CONSTANT;
    if (isBpPurchased) {
        spikerush_xp = spikerush_xp * 1.03;
        average_unrated_xp = average_unrated_xp * 1.03;
    }

    const nextRewardData = await getNextReward(interaction, contractData.progressionLevelReached);

    return {
        success: true,
        bpdata: contractData,
        battlepassPurchased: isBpPurchased,
        nextReward: nextRewardData,
        season_days_left: season_days_left,
        totalxp: totalxp.toLocaleString(),
        xpneeded: (await calculate_level_xp(contractData.progressionLevelReached + 1) - contractData.progressionTowardsNextLevel).toLocaleString(),
        totalxpneeded: Math.max(0, totalxpneeded).toLocaleString(),
        weeklyxp: weeklyxp.toLocaleString(),
        spikerushneeded: Math.max(0, Math.ceil(totalxpneeded / spikerush_xp)).toLocaleString(),
        normalneeded: Math.max(0, Math.ceil(totalxpneeded / average_unrated_xp)).toLocaleString(),
        spikerushneededwithweeklies: Math.max(0, Math.ceil((totalxpneeded - weeklyxp) / spikerush_xp)).toLocaleString(),
        normalneededwithweeklies: Math.max(0, Math.ceil((totalxpneeded - weeklyxp) / average_unrated_xp)).toLocaleString(),
        dailyxpneeded: Math.max(0, Math.ceil(totalxpneeded / season_days_left)).toLocaleString(),
        weeklyxpneeded: Math.max(0, Math.ceil(totalxpneeded / season_weeks_left)).toLocaleString(),
        dailyxpneededwithweeklies: Math.max(0, Math.ceil((totalxpneeded - weeklyxp) / season_days_left)).toLocaleString(),
        weeklyxpneededwithweeklies: Math.max(0, Math.ceil((totalxpneeded - weeklyxp) / season_weeks_left)).toLocaleString()
    };
};

const getWeeklyXP = async (userMissionsObj) => {
    const seasonWeeklyMissions = await getWeeklies();
    let xp = 0;

    if (userMissionsObj.missionArray && userMissionsObj.missionArray.length > 2) {
        userMissionsObj.missionArray.forEach(userMission => {
            if (!userMission.Complete) {
                Object.entries(seasonWeeklyMissions).forEach(([date, weeklyMissions]) => {
                    Object.entries(weeklyMissions).forEach(([uuid, missionDetails]) => {
                        if (uuid === userMission.ID) {
                            xp += missionDetails.xpGrant;
                            userMissionsObj.weeklyCheckpoint = missionDetails.activationDate;
                        }
                    });
                });
            }
        });
    }

    Object.entries(seasonWeeklyMissions).forEach(([date, weeklyMission]) => {
        if (new Date(date) > new Date(userMissionsObj.weeklyCheckpoint)) {
            Object.entries(weeklyMission).forEach(([uuid, missionDetails]) => {
                xp += missionDetails.xpGrant;
            });
        }
    });

    return xp;
};

const getBattlepassPurchase = async (id) => {
    const authSuccess = await authUser(id);
    if (!authSuccess.success) return false;

    const user = getUser(id);
    const data = await getItemEntitlements(user, "f85cb6f7-33e5-4dc8-b609-ec7212301948", "battlepass");
    if (!data?.success || !Array.isArray(data.entitlements?.Entitlements)) return false;

    const battlepassInfo = await getBattlepassInfo();
    for (const entitlement of data.entitlements.Entitlements) {
        if (entitlement.ItemID === battlepassInfo.uuid) {
            return true;
        }
    }
    return false;
};
