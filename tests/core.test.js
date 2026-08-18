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
    WeaponTypeUuid
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
import { basicEmbed, secondaryEmbed, actionRow, removeAlertButton } from "../discord/embed.js";

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
        accounts: [{ ...mockUser.accounts[0], puuid: "puuid-account-2", userId: "discord-user-2" }]
    });
    commitBatchWrites();

    const allIds = getAllUserIds();
    assert.ok(allIds.includes("discord-user-1"));
    assert.ok(allIds.includes("discord-user-2"));

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
