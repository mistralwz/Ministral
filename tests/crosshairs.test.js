import { test } from "node:test";
import assert from "node:assert/strict";
import { saveCrosshair, getCrosshairs, deleteCrosshair } from "../misc/crosshairs.js";

test("crosshairs: save and retrieve", () => {
    const id = "test-crosshair-user-1";
    assert.equal(saveCrosshair(id, "main", "0;s;1;P;c;5;o;1;d;1;z;3;f;0"), true);
    const saved = getCrosshairs(id);
    assert.ok(saved.main);
    assert.match(saved.main.code, /^0;s;1/);
});

test("crosshairs: delete removes entry", () => {
    const id = "test-crosshair-user-2";
    saveCrosshair(id, "temp", "abc123");
    assert.equal(deleteCrosshair(id, "temp"), true);
    assert.equal(deleteCrosshair(id, "temp"), false);
    assert.equal(getCrosshairs(id).temp, undefined);
});

test("crosshairs: overwriting same name works", () => {
    const id = "test-crosshair-user-3";
    saveCrosshair(id, "x", "one");
    saveCrosshair(id, "x", "two");
    assert.equal(getCrosshairs(id).x.code, "two");
});
