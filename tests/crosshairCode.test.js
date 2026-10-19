import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCrosshairProfile } from "../misc/crosshairCode.js";

const profile = {
    bUsePrimaryCrosshairForADS: false,
    bUseCustomCrosshairOnAllPrimary: true,
    bUseAdvancedOptions: true,
    primary: {
        color: { r: 0, g: 255, b: 255, a: 255 },
        bUseCustomColor: false,
        bHasOutline: true,
        outlineThickness: 2,
        outlineOpacity: 0.5,
        bDisplayCenterDot: true,
        centerDotSize: 3,
        centerDotOpacity: 1,
        bFadeCrosshairWithFiringError: false,
        bFixMinErrorAcrossWeapons: true,
        innerLines: {
            bShowLines: true,
            lineThickness: 2,
            lineLength: 6,
            lineLengthVertical: 6,
            bAllowVertScaling: false,
            lineOffset: 3,
            opacity: 0.8,
            bShowMovementError: true,
            bShowShootingError: false,
            movementErrorScale: 1,
            firingErrorScale: 1
        },
        outerLines: {
            bShowLines: false
        }
    },
    aDS: {
        color: { r: 1, g: 2, b: 3, a: 255 }
    },
    sniper: {
        centerDotColor: { r: 255, g: 0, b: 0, a: 255 },
        bDisplayCenterDot: true,
        centerDotSize: 2,
        centerDotOpacity: 1
    }
};

test("crosshairCode: general flags come from the profile toggles", () => {
    const code = encodeCrosshairProfile(profile);
    assert.ok(code.startsWith("0;p;0;c;1;s;1;P;"));
});

test("crosshairCode: a palette colour is written as its index", () => {
    const code = encodeCrosshairProfile(profile);
    assert.ok(code.includes("P;c;5;b;0"));
});

test("crosshairCode: outline, dot and error settings are carried over", () => {
    const code = encodeCrosshairProfile(profile);
    assert.ok(code.includes("h;1;t;2;o;0.5"));
    assert.ok(code.includes("d;1;z;3;a;1"));
    assert.ok(code.includes("f;0;m;1"));
});

test("crosshairCode: inner and outer lines keep their own prefixes", () => {
    const code = encodeCrosshairProfile(profile);
    assert.ok(code.includes("0b;1;0t;2;0l;6;0v;6;0g;0;0o;3;0a;0.8;0m;1;0f;0"));
    assert.ok(code.includes("1b;0;1t;0"));
});

test("crosshairCode: off-palette colours fall back to the custom value", () => {
    const code = encodeCrosshairProfile(profile);
    assert.ok(code.includes("A;c;8;b;1;u;16909311"));
    assert.ok(code.includes(";S;c;7;b;0;d;1;s;2;o;1"));
});

test("crosshairCode: the whole code has the shape the game expects", () => {
    assert.equal(
        encodeCrosshairProfile(profile),
        "0;p;0;c;1;s;1;P;c;5;b;0;h;1;t;2;o;0.5;d;1;z;3;a;1;f;0;m;1;" +
        "0b;1;0t;2;0l;6;0v;6;0g;0;0o;3;0a;0.8;0m;1;0f;0;0s;1;0e;1;" +
        "1b;0;1t;0;1l;0;1v;0;1g;0;1o;0;1a;1;1m;0;1f;0;1s;0;1e;0;" +
        "A;c;8;b;1;u;16909311;h;0;t;0;o;0.5;d;0;z;0;a;1;f;0;m;0;" +
        "0b;1;0t;0;0l;0;0v;0;0g;0;0o;0;0a;1;0m;0;0f;0;0s;0;0e;0;" +
        "1b;1;1t;0;1l;0;1v;0;1g;0;1o;0;1a;1;1m;0;1f;0;1s;0;1e;0;" +
        "S;c;7;b;0;d;1;s;2;o;1"
    );
});

test("crosshairCode: an empty profile still produces a complete code", () => {
    const code = encodeCrosshairProfile({});
    assert.ok(code.startsWith("0;p;1;"));
    assert.ok(code.includes(";P;"));
    assert.ok(code.includes(";A;"));
    assert.ok(code.includes(";S;"));
});
