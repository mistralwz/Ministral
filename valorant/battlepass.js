import { authUser, deleteUserAuth, getUser } from "./auth.js";
import { fetch, isMaintenance, riotClientHeaders, userRegion } from "../misc/util.js";
import { getBattlepassInfo, getBuddy, getCard, getFlex, getSkin, getSpray, getValorantVersion } from "./cache.js";
import { getItemEntitlements } from "./inventory.js";
import { l, s } from "../misc/languages.js";

const AVERAGE_UNRATED_XP_CONSTANT = 4200;
const SPIKERUSH_XP_CONSTANT = 1000;
const LEVEL_MULTIPLIER = 750;

const getWeeklies = async () => {
    console.log("Fetching mission data...");

    const req = await fetch("https://valorant-api.com/v1/missions");
    const json = JSON.parse(req.body);

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
};

const calculate_level_xp = async (level) => {
    if (level <= 50) {
        if (level === 1) return 0;
        return (level - 2) * LEVEL_MULTIPLIER + 2000;
    }
    return 36500;
};

const calculate_total_xp = async (level) => {
    let total_xp = 0;
    for (let i = 1; i <= level; i++) {
        total_xp += await calculate_level_xp(i);
    }
    return total_xp;
};

const getContracts = async (user) => {
    const req = await fetch(`https://pd.${userRegion(user)}.a.pvp.net/contracts/v1/contracts/${user.puuid}`, {
        headers: {
            "Authorization": "Bearer " + user.auth.rso,
            "X-Riot-Entitlements-JWT": user.auth.ent,
            ...riotClientHeaders(),
        }
    });

    const json = JSON.parse(req.body);
    if (json.httpStatus === 400 && json.errorCode === "BAD_CLAIMS") {
        deleteUserAuth(user);
        return { success: false, authFailure: true };
    } else if (isMaintenance(json)) {
        return { success: false, maintenance: true };
    }

    return {
        success: true,
        contracts: json
    };
};

const getBattlepassContract = async (contracts) => {
    const battlepassInfo = await getBattlepassInfo();
    for (const contract of contracts.Contracts) {
        if (contract.ContractDefinitionID === battlepassInfo.battlepassId) {
            return contract;
        }
    }
    return null;
};

const getNextReward = async (interaction, progressionLevelReached) => {
    const battlepassInfo = await getBattlepassInfo();
    const nextReward = battlepassInfo.levels[progressionLevelReached];
    if (!nextReward) return null;

    let item;
    switch (nextReward.rewardType) {
        case "skin":
            item = await getSkin(nextReward.uuid);
            break;
        case "buddy":
            item = await getBuddy(nextReward.uuid);
            break;
        case "spray":
            item = await getSpray(nextReward.uuid);
            break;
        case "card":
            item = await getCard(nextReward.uuid);
            break;
        case "flex":
            item = await getFlex(nextReward.uuid);
            break;
    }

    return {
        name: item ? l(item.names, interaction) : nextReward.name,
        type: nextReward.rewardType,
        icon: item?.icon || nextReward.icon,
        tier: progressionLevelReached + 1
    };
};

export const getBattlepassProgress = async (interaction, maxlevel = 50, targetId = interaction.user.id) => {
    const user = getUser(targetId);
    if (!user) return { success: false };

    const authResult = await authUser(user.id);
    if (!authResult.success) return authResult;

    const contractsResult = await getContracts(user);
    if (!contractsResult.success) return contractsResult;

    const contractData = await getBattlepassContract(contractsResult.contracts);
    if (!contractData) return { success: false };

    const battlepassInfo = await getBattlepassInfo();
    const end_date = new Date(battlepassInfo.endDate);
    const now = new Date();
    const season_days_left = Math.max(1, Math.ceil((end_date - now) / (1000 * 60 * 60 * 24)));
    const season_weeks_left = Math.max(1, Math.ceil(season_days_left / 7));

    let totalxp = 0;
    for (let i = 1; i <= contractData.progressionLevelReached; i++) {
        totalxp += await calculate_level_xp(i);
    }
    totalxp += contractData.progressionTowardsNextLevel;

    const max_xp = await calculate_total_xp(maxlevel);
    const totalxpneeded = max_xp - totalxp;

    const weeklyxp = await getWeeklyXP({
        missionArray: contractsResult.contracts.Missions,
        weeklyCheckpoint: contractsResult.contracts.MissionMetadata.WeeklyCheckpoint
    });

    let average_unrated_xp = AVERAGE_UNRATED_XP_CONSTANT;
    let spikerush_xp = SPIKERUSH_XP_CONSTANT;

    const isBpPurchased = await getBattlepassPurchase(user.id);
    if (isBpPurchased) {
        average_unrated_xp = average_unrated_xp * 1.03;
    }

    return {
        success: true,
        bpdata: contractData,
        battlepassPurchased: isBpPurchased,
        nextReward: await getNextReward(interaction, contractData.progressionLevelReached),
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

    if (userMissionsObj.missionArray.length > 2) {
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
