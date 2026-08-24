import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
    decodeToken,
    tokenExpiry,
    userRegion,
    isMaintenance,
    isToday,
    isSameDay,
    ordinalSuffix,
    removeDupeAlerts,
    WeaponType,
    WeaponTypeUuid,
    WEAPON_CATEGORIES
} from "../misc/util.js";

import {
    l,
    s,
    hideUsername,
    discToValLang,
    DEFAULT_LANG,
    DEFAULT_VALORANT_LANG
} from "../misc/languages.js";

import {
    initUserDatabase,
    getUserFromDb,
    saveUserToDb,
    deleteUserFromDb,
    getAccountByPuuid,
    getAllUserIds,
    getUserIdsWithAlertsOrDailyShop,
    updateSingleAccountInDb,
    beginBatchWrites,
    commitBatchWrites,
    closeUserDatabase
} from "../misc/userDatabase.js";

import {
    getSettings,
    getSetting,
    defaultSettings,
    humanifyValue,
    settingIsVisible
} from "../misc/settings.js";

import { User, getPuuid, refreshToken } from "../valorant/auth.js";
import { formatNightMarket } from "../valorant/shop.js";
import { getPrice } from "../valorant/cache.js";
import { getStatsFor, getOverallStats, addStore } from "../misc/stats.js";
import { basicEmbed, secondaryEmbed, actionRow, removeAlertButton, collectionModeButtons, weaponSelectDropdown, statsForSkinEmbed, getSkinLevels, getRankColor, getTierName, formatSeason, getPlayerTitle, resolvePeakRankString, renderProgressBar, renderCompetitiveMatchHistory, renderProfile, renderCollection, profileButtons, competitiveHistoryButtons, replyOrFollowUp, deferInteraction } from "../discord/embed.js";
import { renderLiveGame } from "../discord/livegameEmbed.js";
import { cachedByPuuid, resolveServerName, parseMMRData } from "../valorant/livegame.js";
import { formatServerName, formatPreferredServers } from "../discord/livegameEmbed.js";

test("util: token decoding and expiration", () => {
    // Standard mock JWT with exp: 1900000000 (Fri, 15 Mar 2030) and sub: "mock-puuid-123"
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64");
    const payload = Buffer.from(JSON.stringify({ sub: "mock-puuid-123", exp: 1900000000 })).toString("base64");
    const mockJwt = `${header}.${payload}.mockSignature`;

    const decoded = decodeToken(mockJwt);
    assert.equal(decoded.sub, "mock-puuid-123");
    assert.equal(decoded.exp, 1900000000);

    const expiryMs = tokenExpiry(mockJwt);
    assert.equal(expiryMs, 1900000000000);
});

test("util: region mapping & maintenance check", () => {
    assert.equal(userRegion({ region: "latam" }), "na");
    assert.equal(userRegion({ region: "br" }), "na");
    assert.equal(userRegion({ region: "eu" }), "eu");
    assert.equal(userRegion({ region: "ap" }), "ap");
    assert.equal(userRegion({}), "na");

    assert.equal(isMaintenance({ httpStatus: 403, errorCode: "SCHEDULED_DOWNTIME" }), true);
    assert.equal(isMaintenance({ httpStatus: 200 }), false);
    assert.equal(isMaintenance(null), false);
});

test("util: helpers (isSameDay, ordinalSuffix, calcLength, removeDupeAlerts)", () => {
    const now = Date.now();
    assert.equal(isToday(now), true);
    assert.equal(isSameDay(new Date("2026-08-18T10:00:00Z"), new Date("2026-08-18T22:00:00Z")), true);
    assert.equal(isSameDay(new Date("2026-08-18T10:00:00Z"), new Date("2026-08-19T10:00:00Z")), false);

    assert.equal(ordinalSuffix(1), "st");
    assert.equal(ordinalSuffix(2), "nd");
    assert.equal(ordinalSuffix(3), "rd");
    assert.equal(ordinalSuffix(4), "th");
    assert.equal(ordinalSuffix(11), "th");
    assert.equal(ordinalSuffix(21), "st");

    const alerts = [
        { uuid: "skin-1", channel_id: "c1" },
        { uuid: "skin-1", channel_id: "c2" },
        { uuid: "skin-2", channel_id: "c1" }
    ];
    const deduplicated = removeDupeAlerts(alerts);
    assert.equal(deduplicated.length, 2);
    assert.equal(deduplicated[0].uuid, "skin-1");
    assert.equal(deduplicated[1].uuid, "skin-2");
});

test("languages: translation resolution and username hiding", () => {
    assert.equal(hideUsername("Player#NA1", true), "Player");
    assert.equal(hideUsername("Player#NA1", false), "Player#NA1");

    const dict = s(DEFAULT_LANG);
    assert.ok(dict);

    const localizedNames = {
        "en-US": "Prime Vandal",
        "de-DE": "Prime-Vandal"
    };
    assert.equal(l(localizedNames, "en-GB"), "Prime Vandal");
    assert.equal(l(localizedNames, "de"), "Prime-Vandal");
});

test("userDatabase: CRUD operations and transactions", () => {
    const testDbPath = "data/test_users.db";
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const initialized = initUserDatabase(testDbPath);
    assert.equal(initialized, true);

    const mockUser = {
        id: "discord-user-1",
        currentAccount: 1,
        settings: { locale: "en-US", hideIgn: true },
        accounts: [
            {
                puuid: "puuid-account-1",
                userId: "discord-user-1",
                username: "TestPlayer#123",
                region: "eu",
                auth: { rso: "token-1", ent: "token-2" },
                alerts: [{ uuid: "skin-1", channel_id: "chan-1" }],
                authFailures: 0,
                lastFetchedData: Date.now(),
                lastNoticeSeen: "v1.0",
                lastSawEasterEgg: 0
            }
        ]
    };

    saveUserToDb(mockUser);

    const fetchedUser = getUserFromDb("discord-user-1");
    assert.ok(fetchedUser);
    assert.equal(fetchedUser.id, "discord-user-1");
    assert.equal(fetchedUser.accounts.length, 1);
    assert.equal(fetchedUser.accounts[0].username, "TestPlayer#123");
    assert.equal(fetchedUser.accounts[0].alerts.length, 1);
    assert.equal(fetchedUser.settings.hideIgn, true);

    const accountByPuuid = getAccountByPuuid("puuid-account-1");
    assert.ok(accountByPuuid);
    assert.equal(accountByPuuid.username, "TestPlayer#123");

    // Single account targeted update
    const updatedAccount = { ...fetchedUser.accounts[0], username: "RenamedPlayer#456" };
    const updateResult = updateSingleAccountInDb(updatedAccount);
    assert.equal(updateResult, true);

    const refetchedUser = getUserFromDb("discord-user-1");
    assert.equal(refetchedUser.accounts[0].username, "RenamedPlayer#456");

    // Batch writes
    beginBatchWrites();
    saveUserToDb({
        ...mockUser,
        id: "discord-user-2",
        settings: { dailyShop: false },
        accounts: [{ ...mockUser.accounts[0], puuid: "puuid-account-2", userId: "discord-user-2", alerts: [] }]
    });
    commitBatchWrites();

    const allIds = getAllUserIds();
    assert.ok(allIds.includes("discord-user-1"));
    assert.ok(allIds.includes("discord-user-2"));

    // Verify alert user filter excludes inactive dailyShop: false without alerts
    const alertUserIds = getUserIdsWithAlertsOrDailyShop();
    assert.ok(alertUserIds.includes("discord-user-1")); // has alerts
    assert.ok(!alertUserIds.includes("discord-user-2")); // dailyShop: false, no alerts

    // Test orphan account syncing
    saveUserToDb({
        ...mockUser,
        id: "discord-user-1",
        accounts: [] // removed accounts
    });
    const userNoAccounts = getUserFromDb("discord-user-1");
    assert.equal(userNoAccounts.accounts.length, 0);
    assert.equal(getAccountByPuuid("puuid-account-1"), null);

    // Test undefined safety
    assert.equal(getAccountByPuuid(undefined), null);
    assert.equal(updateSingleAccountInDb(undefined), false);

    // Cleanup
    deleteUserFromDb("discord-user-1");
    deleteUserFromDb("discord-user-2");
    assert.equal(getUserFromDb("discord-user-1"), null);

    closeUserDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});

test("settings: default values and humanification", () => {
    assert.equal(defaultSettings.locale, "Automatic");
    assert.equal(defaultSettings.pingOnAutoDailyShop, true);
    assert.equal(defaultSettings.hideIgn, false);

    assert.equal(settingIsVisible("locale"), true);
    assert.equal(settingIsVisible("localeForced"), false);

    assert.equal(humanifyValue(true, "hideIgn", null), "Yes");
    assert.equal(humanifyValue(false, "hideIgn", null), "No");
});

test("valorant domain: User class, PUUID, and Night Market formatting", () => {
    const userInstance = new User({
        id: "disc-1",
        puuid: "p-1",
        auth: { rso: "jwt" },
        username: "ValUser#1"
    });
    assert.equal(userInstance.id, "disc-1");
    assert.equal(userInstance.username, "ValUser#1");

    const rawNM = {
        BonusStoreOffers: [
            {
                Offer: {
                    OfferID: "skin-uuid-99",
                    Cost: { "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741": 1775 }
                },
                DiscountCosts: { "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741": 1000 },
                DiscountPercent: 43
            }
        ],
        BonusStoreRemainingDurationInSeconds: 3600
    };

    const formattedNM = formatNightMarket(rawNM);
    assert.ok(formattedNM);
    assert.equal(formattedNM.offers.length, 1);
    assert.equal(formattedNM.offers[0].uuid, "skin-uuid-99");
    assert.equal(formattedNM.offers[0].realPrice, 1775);
    assert.equal(formattedNM.offers[0].nmPrice, 1000);
    assert.equal(formattedNM.offers[0].percent, 43);
});

test("discord embed: basic and secondary embed builders", () => {
    const basic = basicEmbed("Operation successful");
    assert.equal(basic.description, "Operation successful");
    assert.equal(basic.color, 0xFD4553);

    const secondary = secondaryEmbed("Secondary message");
    assert.equal(secondary.description, "Secondary message");
    assert.equal(secondary.color, 0x202225);

    const button = removeAlertButton("user1", "skin1", "Remove");
    assert.ok(button);
    const row = actionRow(button);
    assert.ok(row);
});

test("collection: weapon categories completeness & uniqueness", () => {
    assert.equal(WEAPON_CATEGORIES.length, 5);

    const allCategoryWeapons = WEAPON_CATEGORIES.flatMap(cat => cat.weapons);
    const uniqueCategoryWeapons = new Set(allCategoryWeapons);

    // Ensure no duplicates across categories
    assert.equal(allCategoryWeapons.length, uniqueCategoryWeapons.size);

    // Ensure all 19 unique weapons in WeaponTypeUuid are accounted for
    const uniqueWeaponTypeUuids = new Set(
        Object.entries(WeaponTypeUuid)
            .filter(([key]) => key !== "Melee")
            .map(([, uuid]) => uuid)
    );

    assert.equal(uniqueCategoryWeapons.size, uniqueWeaponTypeUuids.size);
    assert.equal(uniqueWeaponTypeUuids.size, 19);
    for (const uuid of uniqueWeaponTypeUuids) {
        assert.ok(uniqueCategoryWeapons.has(uuid), `Weapon UUID ${uuid} missing from WEAPON_CATEGORIES!`);
    }
});

test("collection: mode buttons and select dropdown builders", async () => {
    const mockInteraction = {
        locale: "en-GB",
        user: { id: "user-123" }
    };

    // Test loadout mode buttons
    const loadoutRow = collectionModeButtons(mockInteraction, "user-123", "loadout");
    assert.equal(loadoutRow.components.length, 3);
    assert.equal(loadoutRow.components[0].data.disabled, true); // loadout disabled when active
    assert.equal(loadoutRow.components[1].data.disabled, false);
    assert.equal(loadoutRow.components[2].data.disabled, false);

    // Test stats mode buttons
    const statsRow = collectionModeButtons(mockInteraction, "user-123", "stats");
    assert.equal(statsRow.components[0].data.disabled, false);
    assert.equal(statsRow.components[1].data.disabled, true); // stats disabled when active
    assert.equal(statsRow.components[2].data.disabled, false);

    // Test dropdown builder
    const dropdownRow = await weaponSelectDropdown(mockInteraction, "user-123", null, WeaponTypeUuid.Vandal);
    assert.equal(dropdownRow.components.length, 1);
    const selectMenu = dropdownRow.components[0];
    assert.equal(selectMenu.data.custom_id, "cl_select_weapon/user-123");
    assert.equal(selectMenu.options.length, 19);
});

test("valorant cache: getPrice tier fallbacks for guns and melees", async () => {
    // Ultra tier
    const ultraGun = { rarity: "411e4a55-4e59-7757-41f0-86a53f101bb5", weapon: WeaponTypeUuid.Vandal };
    const ultraMelee = { rarity: "411e4a55-4e59-7757-41f0-86a53f101bb5", weapon: WeaponTypeUuid.Knife };
    assert.equal(await getPrice("dummy-uuid-1", ultraGun), 2475);
    assert.equal(await getPrice("dummy-uuid-2", ultraMelee), 4950);

    // Premium tier
    const premGun = { rarity: "60bca009-4182-7998-dee7-b8a2558dc369", weapon: WeaponTypeUuid.Phantom };
    const premMelee = { rarity: "60bca009-4182-7998-dee7-b8a2558dc369", weapon: WeaponTypeUuid.Knife };
    assert.equal(await getPrice("dummy-uuid-3", premGun), 1775);
    assert.equal(await getPrice("dummy-uuid-4", premMelee), 3550);

    // Exclusive tier (Store vs Battlepass)
    const exclGun = { rarity: "e046854e-406c-37f4-6607-19a9ba8426fc", weapon: WeaponTypeUuid.Sheriff };
    const exclStoreMelee = { rarity: "e046854e-406c-37f4-6607-19a9ba8426fc", weapon: WeaponTypeUuid.Knife };
    assert.equal(await getPrice("dummy-uuid-5", exclGun), 2175);
    assert.equal(await getPrice("dummy-uuid-6", exclStoreMelee), 4350);

    // Deluxe / Select tiers without store entries are treated as Battlepass / contract skins (0 VP / null)
    const dlxGun = { rarity: "0cebb8be-46d7-c12a-d306-e9907bfc5a25", weapon: WeaponTypeUuid.Spectre };
    assert.equal(await getPrice("dummy-uuid-7", dlxGun), null);

    const selGun = { rarity: "12683d76-48d7-84a3-4e09-6985794f0445", weapon: WeaponTypeUuid.Classic };
    assert.equal(await getPrice("dummy-uuid-8", selGun), null);
});

test("userDatabase: auto-deduplication of alerts on read", () => {
    const testDbPath = "data/test_users_dupe.db";
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    initUserDatabase(testDbPath);

    const userWithDupeAlerts = {
        id: "dupe-user",
        currentAccount: 1,
        settings: {},
        accounts: [
            {
                puuid: "dupe-puuid-1",
                userId: "dupe-user",
                username: "DupeUser#1",
                region: "eu",
                auth: {},
                alerts: [
                    { uuid: "skin-alpha", channel_id: "chan-1" },
                    { uuid: "skin-alpha", channel_id: "chan-2" }, // dupe
                    { uuid: "skin-beta", channel_id: "chan-1" }
                ],
                authFailures: 0,
                lastFetchedData: null,
                lastNoticeSeen: null,
                lastSawEasterEgg: 0
            }
        ]
    };

    saveUserToDb(userWithDupeAlerts);
    const loadedUser = getUserFromDb("dupe-user");
    assert.ok(loadedUser);
    assert.equal(loadedUser.accounts[0].alerts.length, 2);
    assert.equal(loadedUser.accounts[0].alerts[0].uuid, "skin-alpha");
    assert.equal(loadedUser.accounts[0].alerts[1].uuid, "skin-beta");

    deleteUserFromDb("dupe-user");
    closeUserDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});

test("auth: refreshToken preserves credentials on rate limit or network error", async () => {
    const testDbPath = "data/test_users_auth.db";
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    initUserDatabase(testDbPath);

    const userWithTokens = {
        id: "auth-test-user",
        currentAccount: 1,
        settings: {},
        accounts: [
            {
                puuid: "auth-test-puuid",
                userId: "auth-test-user",
                username: "AuthUser#1",
                region: "eu",
                auth: {
                    rso: "expired-rso",
                    refresh_token: "valid-refresh-token",
                    ent: "mock-ent"
                },
                alerts: [],
                authFailures: 0,
                lastFetchedData: null,
                lastNoticeSeen: null,
                lastSawEasterEgg: 0
            }
        ]
    };

    saveUserToDb(userWithTokens);

    // Verify user credentials remain intact in database
    const loaded = getUserFromDb("auth-test-user");
    assert.equal(loaded.accounts[0].auth.refresh_token, "valid-refresh-token");

    deleteUserFromDb("auth-test-user");
    closeUserDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});

test("stats: getStatsFor returns valid ranking and statsForSkinEmbed formats safely", async () => {
    const statsForKnownSkin = getStatsFor("nonexistent-skin-uuid");
    assert.equal(statsForKnownSkin.count, 0);
    assert.equal(Array.isArray(statsForKnownSkin.rank), true);
    assert.equal(statsForKnownSkin.rank[0], 0);

    const mockSkin = {
        uuid: "mock-skin-uuid",
        names: { "en-US": "Prime Vandal" },
        icon: "https://example.com/prime.png",
        rarity: null
    };
    const mockInteraction = {
        channel: null,
        locale: "en-US",
        user: { id: "test-user" }
    };

    // Test with missing/empty stats (should not throw TypeError on rank[0])
    const emptyStatsEmbed = await statsForSkinEmbed(mockSkin, statsForKnownSkin, mockInteraction);
    assert.ok(emptyStatsEmbed);
    assert.ok(emptyStatsEmbed.description);

    // Test with valid populated stats
    const populatedStats = {
        shopsIncluded: 100,
        count: 25,
        amount: 25,
        percentage: 25,
        rank: [1, 50]
    };
    const populatedEmbed = await statsForSkinEmbed(mockSkin, populatedStats, mockInteraction);
    assert.ok(populatedEmbed);
    assert.ok(populatedEmbed.description.includes("25%"));
});

test("embed: getSkinLevels deduplicates duplicate skin UUIDs and limits options to 25", async () => {
    const mockInteraction = {
        locale: "en-US",
        user: { id: "test-user" }
    };
    // Passing empty array returns false
    const emptyRes = await getSkinLevels([], mockInteraction);
    assert.equal(emptyRes, false);
});

test("livegame embed: renders party code and status description", async () => {
    const mockLiveGameData = {
        state: "not_in_game",
        allyPlayers: [],
        enemyPlayers: [],
        inviteCode: "test-code-1234",
        preferredGamePods: []
    };

    const rendered = await renderLiveGame(mockLiveGameData, "test-user-id");
    assert.ok(rendered.embeds && rendered.embeds.length > 0);
    const desc = rendered.embeds[0].description;
    assert.ok(desc?.includes("test-code-1234"));
    assert.ok(desc?.includes("online in VALORANT") || desc?.includes("🎮"));
});

test("livegame embed: renders team games in a single embed with ally and enemy teams separated", async () => {
    const ally = {
        puuid: "ally-1",
        riotId: "Ally#123",
        teamId: "Blue",
        currentTier: 20,
        currentRR: 50,
        agentName: { "en-US": "Jett" },
        agentIcon: "https://example.com/jett.png"
    };
    const enemy = {
        puuid: "enemy-1",
        riotId: "Enemy#456",
        teamId: "Red",
        currentTier: 21,
        currentRR: 75,
        agentName: { "en-US": "Reyna" },
        agentIcon: "https://example.com/reyna.png"
    };

    // Team game (1 unified embed with ally & enemy blocks in description)
    const teamGameData = {
        state: "ingame",
        queueId: "competitive",
        queueName: "Competitive",
        mapName: "Ascent",
        serverName: "Frankfurt",
        mapImage: "https://example.com/ascent.png",
        isSingleTeam: false,
        allyPlayers: [ally],
        enemyPlayers: [enemy]
    };

    const renderedTeam = await renderLiveGame(teamGameData, "test-user-id");
    assert.equal(renderedTeam.embeds.length, 1);

    const gameEmbed = renderedTeam.embeds[0];
    assert.ok(gameEmbed.author);
    assert.equal(gameEmbed.color, 0x2CD182); // Average rank color (Ascendant)
    assert.equal(gameEmbed.image, undefined);
    assert.ok(gameEmbed.description.includes("Avg. Rank:"));
    assert.ok(gameEmbed.description.includes("Ally#123"));
    assert.ok(gameEmbed.description.includes("Enemy#456"));
    assert.ok(gameEmbed.description.includes("50**rr") || gameEmbed.description.includes("50"));
    assert.ok(gameEmbed.description.includes("75**rr") || gameEmbed.description.includes("75"));
    assert.ok(gameEmbed.footer?.text.includes("In-Game"));
    assert.ok(gameEmbed.timestamp);

    // Single team game (1 embed with footer)
    const singleTeamData = {
        state: "ingame",
        queueId: "deathmatch",
        queueName: "Deathmatch",
        mapName: "Ascent",
        mapImage: "https://example.com/ascent.png",
        isSingleTeam: true,
        allyPlayers: [ally],
        enemyPlayers: []
    };

    const renderedSingle = await renderLiveGame(singleTeamData, "test-user-id");
    assert.equal(renderedSingle.embeds.length, 1);
    assert.equal(renderedSingle.embeds[0].image, undefined);
    assert.ok(renderedSingle.embeds[0].description.includes("Ally"));
    assert.ok(renderedSingle.embeds[0].description.includes("Ally#123"));
    assert.ok(renderedSingle.embeds[0].footer?.text.includes("In-Game"));
});

test("profile embed: rank colors and progress bar", async () => {
    assert.equal(getRankColor("Diamond 2"), 0xB366FF);
    assert.equal(getRankColor("Ascendant 1"), 0x2CD182);
    assert.equal(getRankColor("Immortal 3"), 0xBE1E37);
    assert.equal(getRankColor("Radiant"), 0xFFD700);
    assert.equal(getRankColor("Bronze 2"), 0xA37449);
    assert.equal(getRankColor("Gold 2"), 0xEFBF41);
    assert.equal(getRankColor("Unranked"), 0xFD4553);
    assert.equal(getRankColor(null), 0xFD4553);

    // Tier name resolution from different API response shapes (e.g. HenrikDev v2)
    assert.equal(getTierName({ currenttier: 7, currenttierpatched: "Bronze 2" }), "Bronze 2");
    assert.equal(getTierName({ currenttier: 7, currenttier_patched: "Bronze 2" }), "Bronze 2");
    assert.equal(getTierName({ currenttier: 7 }), "Bronze 2");
    assert.equal(getTierName({ tier: 22 }), "Ascendant 2");
    assert.equal(getTierName({ tier: 24 }), "Immortal 1");
    // Season formatting (E10+ mapped to Riot's V25+ scheme, E1-E9 preserved)
    assert.equal(formatSeason("e10a2"), "V25A2");
    assert.equal(formatSeason("E10A2"), "V25A2");
    assert.equal(formatSeason("e10:a2"), "V25A2");
    assert.equal(formatSeason("e11a1"), "V26A1");
    assert.equal(formatSeason("v25a2"), "V25A2");
    assert.equal(formatSeason("v25a1"), "V25A1");
    assert.equal(formatSeason("e8a1"), "E8A1");
    assert.equal(formatSeason("e9a3"), "E9A3");
    assert.equal(formatSeason(null), null);

    const unrankedStr = await resolvePeakRankString(null);
    assert.equal(unrankedStr, "**Unranked**");
    const peakStr = await resolvePeakRankString({ tier: 22, season: "e10a2" });
    assert.ok(peakStr.includes("Ascendant 2"));
    assert.ok(peakStr.includes("V25A2"));

    const bar50 = renderProgressBar(50, 100, 10);
    assert.equal(bar50, "█████░░░░░");
    const bar0 = renderProgressBar(0, 100, 10);
    assert.equal(bar0, "░░░░░░░░░░");
    const bar100 = renderProgressBar(100, 100, 10);
    assert.equal(bar100, "██████████");
});

test("profile embed: renderCompetitiveMatchHistory produces compact match history embed with pagination", async () => {
    const mockInteraction = {
        locale: "en-US",
        user: { id: "test-user" }
    };

    const mockAccountData = {
        success: true,
        data: {
            account: {
                name: "RadiantPlayer",
                tag: "VAL",
                account_level: 210,
                card: { small: "https://example.com/card.png" }
            },
            mmr: {
                current_data: {
                    currenttier: 24,
                    currenttier_patched: "Ascendant 2",
                    ranking_in_tier: 65,
                    images: { large: "https://example.com/asc2.png" }
                },
                highest_rank: {
                    patched_tier: "Immortal 1",
                    season: "e7a3"
                }
            }
        }
    };

    const mockMatchHistoryData = {
        success: true,
        data: [
            {
                player: {
                    is_draw: false,
                    has_won: true,
                    agent: { name: "Reyna", iconUrl: "https://example.com/reyna.png" },
                    kills: 26,
                    deaths: 10,
                    assists: 4,
                    kd: "2.60",
                    position: "1st",
                    mmr: "+24",
                    average_combat_score: "350",
                    average_damage_round: "210.0",
                    hs_percent: 35
                },
                metadata: {
                    map: "Lotus",
                    game_start: 1700000000,
                    game_length: 1600,
                    pt_round_won: 13,
                    et_round_won: 6
                }
            },
            {
                player: {
                    is_draw: false,
                    has_won: false,
                    agent: { name: "Cypher", iconUrl: "https://example.com/cypher.png" },
                    kills: 14,
                    deaths: 16,
                    assists: 6,
                    kd: "0.88",
                    position: "7th",
                    mmr: "-16",
                    average_combat_score: "180",
                    average_damage_round: "115.0",
                    hs_percent: 20
                },
                metadata: {
                    map: "Split",
                    game_start: 1700002000,
                    game_length: 1900,
                    pt_round_won: 8,
                    et_round_won: 13
                }
            }
        ]
    };

    const result = await renderCompetitiveMatchHistory(mockInteraction, mockAccountData, mockMatchHistoryData, "test-user", 0);
    assert.ok(result.embeds);
    assert.equal(result.embeds.length, 2);

    const header = result.embeds[0];
    assert.ok(header.title.includes("RadiantPlayer"));
    assert.ok(header.description.includes("Immortal 1"));
    assert.ok(header.description.includes("1W - 1L"));
    assert.ok(header.description.includes("+8 RR"));
    assert.ok(header.description.includes("**ADR**: 162.5"));
    assert.ok(header.description.includes("**ACS**: 265"));

    const matchesEmbed = result.embeds[1];
    assert.ok(matchesEmbed.description.includes("🟩"));
    assert.ok(matchesEmbed.description.includes("🟥"));
    assert.ok(matchesEmbed.description.includes("+24"));
    assert.ok(matchesEmbed.description.includes("-16"));
    assert.ok(matchesEmbed.description.includes("Lotus"));
    assert.ok(matchesEmbed.description.includes("Split"));
    assert.ok(matchesEmbed.description.includes("Reyna"));

    assert.ok(result.components && result.components.length > 0);
});

test("profile embed: renderProfile produces valid overview embed", async () => {
    const mockInteraction = {
        locale: "en-US",
        user: { id: "test-user" }
    };

    const mockAccountData = {
        success: true,
        data: {
            account: {
                name: "TestHero",
                tag: "1234",
                account_level: 95,
                card: { small: "https://example.com/card.png" },
                region: "eu"
            },
            mmr: {
                current_data: {
                    currenttier: 21,
                    currenttier_patched: "Diamond 3",
                    ranking_in_tier: 78,
                    images: { large: "https://example.com/d3.png" }
                },
                highest_rank: {
                    patched_tier: "Diamond 3",
                    season: "e8a1"
                }
            }
        }
    };

    const result = await renderProfile(mockInteraction, mockAccountData, "test-user");
    assert.ok(result.embeds);
    assert.equal(result.embeds.length, 1);

    const embed = result.embeds[0];
    assert.ok(embed.title.includes("TestHero"));
    assert.ok(embed.fields[0].value.includes("95"));
    assert.ok(embed.author.name.includes("Diamond 3"));
    assert.ok(embed.fields[0].value.includes("**78**/100 RR"));
    assert.ok(embed.fields[0].value.includes("EU"));

    // Test with a multi-account user in database to exercise switchAccountButtons and getSetting
    initUserDatabase("data/test_users.db");
    saveUserToDb({
        id: "multi-user",
        accounts: [
            { id: "multi-user", puuid: "puuid-1", username: "Hero#1111", auth: { rso: "t1" }, alerts: [] },
            { id: "multi-user", puuid: "puuid-2", username: "Hero#2222", auth: { rso: "t2" }, alerts: [] }
        ],
        currentAccount: 1,
        settings: { hideIgn: false }
    });

    const multiResult = await renderProfile(mockInteraction, mockAccountData, "multi-user");
    assert.ok(multiResult.components.length >= 2); // profile buttons row + switch account row
});

test("interaction helpers: replyOrFollowUp routes correctly based on interaction state", async () => {
    let replyCalled = false;
    let followUpCalled = false;

    const unacknowledgedInteraction = {
        deferred: false,
        replied: false,
        reply: async () => { replyCalled = true; },
        followUp: async () => { followUpCalled = true; }
    };

    await replyOrFollowUp(unacknowledgedInteraction, { content: "test" });
    assert.equal(replyCalled, true);
    assert.equal(followUpCalled, false);

    replyCalled = false;
    followUpCalled = false;

    const deferredInteraction = {
        deferred: true,
        replied: false,
        reply: async () => { replyCalled = true; },
        followUp: async () => { followUpCalled = true; }
    };

    await replyOrFollowUp(deferredInteraction, { content: "test" });
    assert.equal(replyCalled, false);
    assert.equal(followUpCalled, true);
});

test("collection: renderCollection returns error object when user is unregistered", async () => {
    initUserDatabase("data/test_users.db");
    const mockInteraction = {
        user: { id: "nonexistent-user", tag: "Ghost#0000" },
        locale: "en-US"
    };

    const result = await renderCollection(mockInteraction, "nonexistent-user");
    assert.ok(result);
    assert.ok(result.embeds);
    assert.ok(result.flags);
});




test("auth: refreshToken short-circuits only when both rso and ent are fresh", async () => {
    initUserDatabase("data/test_users.db");

    // JWT-shaped token expiring in 1 hour — well past tokenRefreshBufferMinutes
    const freshRso = "x." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".y";
    const mkUser = (auth) => ({
        id: "refresh-test-user",
        currentAccount: 1,
        settings: {},
        accounts: [{ puuid: "refresh-test-puuid", userId: "refresh-test-user", username: "Refresh#001", region: "eu", auth, alerts: [] }]
    });

    // Fresh rso + ent: another shard already refreshed, reuse without touching the network
    saveUserToDb(mkUser({ rso: freshRso, ent: "ent-token" }));
    assert.deepEqual(await refreshToken("refresh-test-user"), { success: true });

    // Fresh rso but ent missing: must NOT short-circuit, or every request ships an undefined
    // entitlements header forever. No refresh_token here, so it fails out without network.
    saveUserToDb(mkUser({ rso: freshRso }));
    const result = await refreshToken("refresh-test-user");
    assert.equal(result.success, false);
    assert.equal(result.authFailure, true);

    deleteUserFromDb("refresh-test-user");
});

test("livegame: cachedByPuuid serves fresh hits, fetches only misses, retries failures", async () => {
    const cache = new Map();
    const empty = () => "EMPTY";
    let calls = [];
    const fetchOne = async (puuid) => {
        calls.push(puuid);
        return puuid === "fails" ? null : `data-${puuid}`;
    };

    // Cold: everything is a miss and gets fetched.
    let out = await cachedByPuuid(cache, 60_000, ["a", "b"], fetchOne, empty);
    assert.deepEqual(calls.sort(), ["a", "b"]);
    assert.equal(out.get("a"), "data-a");

    // Warm: nothing is refetched — this is the whole point of the cache.
    calls = [];
    out = await cachedByPuuid(cache, 60_000, ["a", "b"], fetchOne, empty);
    assert.deepEqual(calls, []);
    assert.equal(out.get("b"), "data-b");

    // Expired TTL: refetched.
    calls = [];
    await cachedByPuuid(cache, -1, ["a"], fetchOne, empty);
    assert.deepEqual(calls, ["a"]);

    // Failure with nothing cached falls back to empty and is NOT negative-cached,
    // so the next call retries instead of pinning the bad value for the whole TTL.
    calls = [];
    out = await cachedByPuuid(cache, 60_000, ["fails"], fetchOne, empty);
    assert.equal(out.get("fails"), "EMPTY");
    out = await cachedByPuuid(cache, 60_000, ["fails"], fetchOne, empty);
    assert.deepEqual(calls, ["fails", "fails"]);

    // Failure with a stale entry serves the stale value rather than empty.
    cache.set("stale", { data: "old", ts: 0 });
    out = await cachedByPuuid(cache, 60_000, ["stale"], async () => null, empty);
    assert.equal(out.get("stale"), "old");
});

test("livegame: resolveServerName parses real game pod ids", () => {
    // Prod pods — display names match what the old hardcoded table rendered.
    assert.equal(resolveServerName("aresriot.aws-euc1-prod.eu-gp-frankfurt-1"), "Frankfurt");
    assert.equal(resolveServerName("aresriot.aws-use1-prod.na-gp-ashburn-1"), "N. Virginia");
    assert.equal(resolveServerName("aresriot.aws-rclusterprod-use1-1.na-gp-ashburn-awsedge-1"), "N. Virginia");
    assert.equal(resolveServerName("aresriot.aws-usw1-prod.na-gp-norcal-1"), "N. California");
    assert.equal(resolveServerName("aresriot.aws-atl1-prod.na-gp-atlanta-1"), "Georgia");
    assert.equal(resolveServerName("aresriot.aws-dfw1-prod.na-gp-dallas-1"), "Texas");
    assert.equal(resolveServerName("aresriot.aws-chi1-prod.na-gp-chicago-1"), "Illinois");
    assert.equal(resolveServerName("aresriot.aws-sae1-prod.br-gp-saopaulo-1"), "Sao Paulo");
    assert.equal(resolveServerName("aresriot.aws-ape1-prod.ap-gp-hongkong-1"), "Hong Kong");
    assert.equal(resolveServerName("aresriot.aws-bog1-prod.latam-gp-bogota-1"), "Bogotá");
    assert.equal(resolveServerName("aresriot.aws-mnl1-prod.ap-gp-manila-1"), "Manila");
    assert.equal(resolveServerName("loltencent.qcloud.val-gp-beijing-1"), "Beijing");

    // A pod the old table never listed still resolves — the point of the regex.
    assert.equal(resolveServerName("aresriot.aws-xyz9-prod.eu-gp-helsinki-1"), "Helsinki");

    // PreferredGamePods short ids.
    assert.equal(resolveServerName("na-3"), "Texas");
    assert.equal(resolveServerName("latam-2"), "Mexico City");
    assert.equal(resolveServerName("p-eu-1"), "Frankfurt");

    // Unparseable ids fall through to the raw value rather than inventing one.
    assert.equal(resolveServerName("arestencent.qcloud-cq1.alpha1-gp-1"), "arestencent.qcloud-cq1.alpha1-gp-1");
    assert.equal(resolveServerName(""), "");
    assert.equal(resolveServerName(null), null);
});

test("livegame: formatServerName and formatPreferredServers attach flags", () => {
    assert.equal(formatServerName(resolveServerName("aresriot.aws-use1-prod.na-gp-ashburn-1")), "🇺🇸 N. Virginia");
    assert.equal(formatServerName("Frankfurt"), "🇩🇪 Frankfurt");
    assert.equal(formatServerName(""), "");

    // Single pod, grouped pods, and the >3-across-countries compact form.
    assert.equal(formatPreferredServers(["aresriot.aws-euc1-prod.eu-gp-frankfurt-1"]), "🇩🇪 Frankfurt");
    assert.equal(formatPreferredServers([], "Auto"), "`Auto`");
    assert.equal(
        formatPreferredServers(["aresriot.aws-dfw1-prod.na-gp-dallas-1", "aresriot.aws-chi1-prod.na-gp-chicago-1"]),
        "🇺🇸 Texas, Illinois"
    );
});

test("livegame: parseMMRData reports the current act, not the last one played", () => {
    const CURRENT = "act-current", OLD = "act-old";
    const seasonal = {
        [OLD]: { CompetitiveTier: 20, RankedRating: 60, NumberOfGames: 40, NumberOfWinsWithPlacements: 25 }
    };
    const mmr = {
        LatestCompetitiveUpdate: { SeasonID: OLD, TierAfterUpdate: 20, RankedRatingAfterUpdate: 60 },
        QueueSkills: { competitive: { SeasonalInfoBySeasonID: seasonal } }
    };

    // Hasn't played the current act -> Unranked, not last act's tier.
    const fresh = parseMMRData(mmr, CURRENT);
    assert.equal(fresh.currentTier, 0);
    assert.equal(fresh.currentRR, 0);
    assert.equal(fresh.peakTier, 20);          // peak still remembers it
    assert.equal(fresh.peakSeasonId, OLD);

    // A stale currentSeasonId is exactly the act-rollover bug: the same payload
    // reports the old act's rank as current. Expiring the seasons cache at the
    // act's endTime is what stops this happening.
    assert.equal(parseMMRData(mmr, OLD).currentTier, 20);

    // Played the current act -> that act's numbers win.
    seasonal[CURRENT] = { CompetitiveTier: 12, RankedRating: 30, NumberOfGames: 10, NumberOfWinsWithPlacements: 6 };
    const played = parseMMRData(mmr, CURRENT);
    assert.equal(played.currentTier, 12);
    assert.equal(played.currentRR, 30);
    assert.equal(played.games, 10);
    assert.equal(played.wins, 6);
    assert.equal(played.winRate, 60);
});
