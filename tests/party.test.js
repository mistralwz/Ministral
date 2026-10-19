import { test } from "node:test";
import assert from "node:assert/strict";
import { isWatching, cancelWatcher, stopAllWatchers, startQueueWatcher } from "../valorant/queueWatcher.js";
import { getFriendsOverview, parseValorantPresence } from "../valorant/party.js";

test("queueWatcher: watcher state starts empty and cancels cleanly", () => {
    assert.equal(isWatching("123456789"), false);
    cancelWatcher("123456789");
    stopAllWatchers();
    assert.equal(isWatching("123456789"), false);
});

test("queueWatcher: starting a watch then cancelling it leaves nothing behind", () => {
    const interaction = { followUp: async () => {}, editReply: async () => {} };

    startQueueWatcher("987654321", interaction, "party-id", "competitive");
    assert.equal(isWatching("987654321"), true);

    cancelWatcher("987654321");
    stopAllWatchers();
    assert.equal(isWatching("987654321"), false);
});

test("party: unauthenticated friend lookup fails gracefully", async () => {
    const res = await getFriendsOverview("0", null);
    assert.equal(res.success, false);
});

test("party: presence blob is decoded into a live session state", () => {
    const blob = Buffer.from(JSON.stringify({
        sessionLoopState: "INGAME",
        queueId: "competitive",
        partySize: 3,
        accountLevel: 120,
        competitiveTier: 14
    })).toString("base64");

    assert.deepEqual(parseValorantPresence(blob), {
        state: "INGAME",
        queueId: "competitive",
        partySize: 3,
        partyId: null,
        level: 120,
        tier: 14
    });
});

test("party: missing or unparseable presence data is ignored", () => {
    assert.deepEqual(parseValorantPresence(null), {});
    assert.deepEqual(parseValorantPresence(""), {});
    assert.deepEqual(parseValorantPresence("not json"), {});
});
