// Turns the crosshair profiles the Riot Client stores in
// EAresStringSettingName::SavedCrosshairProfileData into the codes players
// share with each other.
//
// The code format is the flat `key;value` stream the game itself parses:
// a `0` prefix with the general flags, then the `P` (primary), `A` (ADS) and
// `S` (sniper) sections. Keys and their accepted ranges follow the decoder
// used by LilyBergonzat/Crosshair; the profile field names follow the payload
// the client actually stores.

const COLOURS = [
    [255, 255, 255],
    [0, 255, 0],
    [127, 255, 0],
    [223, 255, 0],
    [255, 255, 0],
    [0, 255, 255],
    [255, 0, 255],
    [255, 0, 0]
];

const byte = (value, fallback = 255) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(255, Math.round(number)));
};

const whole = (value, min = 0, max = 20) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, Math.round(number)));
};

const fraction = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, Math.round(number * 1000) / 1000));
};

const flag = (value) => (value ? 1 : 0);

/** Index of a colour in the game's palette, or -1 when it's a custom one. */
const colourIndex = (colour) => {
    if (!colour) return -1;
    const r = byte(colour.r, -1);
    const g = byte(colour.g, -1);
    const b = byte(colour.b, -1);
    return COLOURS.findIndex(([cr, cg, cb]) => cr === r && cg === g && cb === b);
};

/** R G B A as the 32 bit number the code stores, e.g. FFFFFFFF. */
const colourValue = (colour) => {
    const r = byte(colour?.r);
    const g = byte(colour?.g);
    const b = byte(colour?.b);
    const a = byte(colour?.a);
    return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
};

const colourTokens = (settings = {}) => {
    const custom = Boolean(settings.bUseCustomColor);
    const colour = custom ? settings.colorCustom : settings.color;
    const index = custom ? 8 : colourIndex(colour);

    // A palette colour the game doesn't recognise (or an explicit custom one)
    // is written as the custom variant, which always carries the exact RGB.
    const resolvedIndex = index < 0 ? 8 : index;
    const tokens = [`c;${resolvedIndex}`, `b;${flag(resolvedIndex === 8)}`];
    if (resolvedIndex === 8) tokens.push(`u;${colourValue(colour)}`);
    return tokens;
};

const lineTokens = (prefix, line = {}) => [
    `${prefix}b;${flag(line.bShowLines !== false)}`,
    `${prefix}t;${whole(line.lineThickness, 0, 10)}`,
    `${prefix}l;${whole(line.lineLength, 0, 20)}`,
    `${prefix}v;${whole(line.lineLengthVertical, 0, 20)}`,
    `${prefix}g;${flag(line.bAllowVertScaling)}`,
    `${prefix}o;${whole(line.lineOffset, 0, 40)}`,
    `${prefix}a;${fraction(line.opacity === undefined ? 1 : line.opacity)}`,
    `${prefix}m;${flag(line.bShowMovementError)}`,
    `${prefix}f;${flag(line.bShowShootingError)}`,
    `${prefix}s;${fraction(line.movementErrorScale)}`,
    `${prefix}e;${fraction(line.firingErrorScale)}`
];

const primaryTokens = (settings = {}) => [
    ...colourTokens(settings),
    `h;${flag(settings.bHasOutline)}`,
    `t;${whole(settings.outlineThickness, 0, 6)}`,
    `o;${fraction(settings.outlineOpacity === undefined ? 0.5 : settings.outlineOpacity)}`,
    `d;${flag(settings.bDisplayCenterDot)}`,
    `z;${whole(settings.centerDotSize, 0, 6)}`,
    `a;${fraction(settings.centerDotOpacity === undefined ? 1 : settings.centerDotOpacity)}`,
    `f;${flag(settings.bFadeCrosshairWithFiringError)}`,
    `m;${flag(settings.bFixMinErrorAcrossWeapons)}`,
    ...lineTokens("0", settings.innerLines),
    ...lineTokens("1", settings.outerLines)
];

const sniperTokens = (sniper = {}) => {
    const custom = Boolean(sniper.bUseCustomCenterDotColor);
    const colour = custom ? sniper.centerDotColorCustom : sniper.centerDotColor;
    const index = custom ? 8 : colourIndex(colour);
    const resolvedIndex = index < 0 ? 8 : index;

    const tokens = [`c;${resolvedIndex}`, `b;${flag(resolvedIndex === 8)}`];
    if (resolvedIndex === 8) tokens.push(`t;${colourValue(colour)}`);
    tokens.push(
        `d;${flag(sniper.bDisplayCenterDot)}`,
        `s;${whole(sniper.centerDotSize, 0, 4)}`,
        `o;${fraction(sniper.centerDotOpacity === undefined ? 1 : sniper.centerDotOpacity)}`
    );
    return tokens;
};

export const encodeCrosshairProfile = (profile = {}) => [
    "0",
    `p;${flag(profile.bUsePrimaryCrosshairForADS !== false)}`,
    `c;${flag(profile.bUseCustomCrosshairOnAllPrimary)}`,
    `s;${flag(profile.bUseAdvancedOptions)}`,
    "P", ...primaryTokens(profile.primary),
    "A", ...primaryTokens(profile.aDS),
    "S", ...sniperTokens(profile.sniper)
].join(";");
