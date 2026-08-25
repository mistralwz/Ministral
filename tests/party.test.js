import { test } from "node:test";
import assert from "node:assert/strict";
import { isWatching, cancelWatcher, stopAllWatchers } from "../valorant/queueWatcher.js";
import { getFriendsOverview, getPresences } from "../valorant/party.js";

test("queueWatcher: watcher state starts empty and cancels cleanly", () => {
    assert.equal(isWatching("123456789"), false);
    cancelWatcher("123456789");
    stopAllWatchers();
    assert.equal(isWatching("123456789"), false);
});

test("party: unauthenticated friend lookup fails gracefully", async () => {
    const res = await getFriendsOverview("0", null);
    assert.equal(res.success, false);
});

test("party: unauthenticated presence lookup fails gracefully", async () => {
    const res = await getPresences("0", null);
    assert.equal(res.success, false);
});
