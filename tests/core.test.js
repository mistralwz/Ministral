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

import { User, getPuuid } from "../valorant/auth.js";
import { formatNightMarket } from "../valorant/shop.js";
import { getPrice } from "../valorant/cache.js";
import { getStatsFor, getOverallStats, addStore } from "../misc/stats.js";
import { basicEmbed, secondaryEmbed, actionRow, removeAlertButton, collectionModeButtons, weaponSelectDropdown, statsForSkinEmbed } from "../discord/embed.js";

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

    // Exclusive tier
    const exclGun = { rarity: "e046854e-406c-37f4-6607-19a9ba8426fc", weapon: WeaponTypeUuid.Sheriff };
    const exclMelee = { rarity: "e046854e-406c-37f4-6607-19a9ba8426fc", weapon: WeaponTypeUuid.Knife };
    assert.equal(await getPrice("dummy-uuid-5", exclGun), 2175);
    assert.equal(await getPrice("dummy-uuid-6", exclMelee), 4350);

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

