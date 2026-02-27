import { asyncReadJSONFile, fetch, itemTypes } from "../misc/util.js";
import config from "../misc/config.js";
import fuzzysort from "fuzzysort";
import fs from "fs";
import { DEFAULT_VALORANT_LANG, discToValLang } from "../misc/languages.js";
import { client } from "../discord/bot.js";
import { sendShardMessage } from "../misc/shardMessage.js";

const formatVersion = 14;
let gameVersion;

let weapons, skins, rarities, buddies, sprays, cards, titles, bundles, battlepass;
let prices = { timestamp: null };

// Inverted index: uuid → price, built from bundle items for O(1) fallback in getPrice()
let bundleItemPrices = {};

let skinsSaveDirty = false;
let skinsSaveTimer = null;
const SKINS_SAVE_DEBOUNCE_MS = 3000;

// Cached result from getAllSkins() — invalidated on skin/price reload
let allSkinsCache = null;
let allSkinsCacheVersion = null;

let lastBundleFetch = 0;

// Fast-path flag: set to true once all data types have been loaded at least once.
// Prevents getSkin()/getBundle()/etc. from entering fetchData() on every call.
let dataFullyLoaded = false;

// In-flight promise guards — prevents concurrent callers from firing duplicate requests.
let versionFetchPromise = null;
let fetchDataPromise = null;

export const clearCache = () => {
    weapons = skins = rarities = buddies = sprays = cards = titles = bundles = battlepass = null;
    prices = { timestamp: null };
    allSkinsCache = null;
    bundleItemPrices = {};
    dataFullyLoaded = false;
}

// Returns true once all 9 skin/item data types have been loaded at least once.
// Used by non-zero shards to check if loadSkinsJSON() succeeded at startup.
export const areSkinDataLoaded = () => dataFullyLoaded;

export const getValorantVersion = async () => {
    // If a request is already in-flight, reuse it instead of firing a second one.
    if (versionFetchPromise) return versionFetchPromise;

    versionFetchPromise = (async () => {
        console.log("Fetching current valorant version...");
        const req = await fetch("https://valorant-api.com/v1/version");
        console.assert(req.statusCode === 200, `Valorant version status code is ${req.statusCode}!`, req);
        const json = JSON.parse(req.body);
        console.assert(json.status === 200, `Valorant version data status code is ${json.status}!`, json);
        return json.data;
    })();

    try {
        return await versionFetchPromise;
    } finally {
        versionFetchPromise = null;
    }
}

export const loadSkinsJSON = async (filename = "data/skins.json") => {
    // Reset fast-path flag before the async read so any concurrent getSkin() call
    // that checks dataFullyLoaded will re-enter fetchData() and wait rather than
    // reading partially-stale data from the previous load.
    dataFullyLoaded = false;
    allSkinsCache = null;

    const jsonData = await asyncReadJSONFile(filename).catch(() => { });
    if (!jsonData || jsonData.formatVersion !== formatVersion) return;

    // Assign all fields synchronously (single tick, no interleaving possible)
    weapons = jsonData.weapons;
    skins = jsonData.skins;
    prices = jsonData.prices;
    rarities = jsonData.rarities;
    bundles = jsonData.bundles;
    buddies = jsonData.buddies;
    sprays = jsonData.sprays;
    cards = jsonData.cards;
    titles = jsonData.titles;
    battlepass = jsonData.battlepass;
    buildBundleItemPrices();

    // Re-set the fast-path flag now that all fields are consistent
    if (skins && prices && bundles && rarities && buddies && cards && sprays && titles && battlepass) {
        dataFullyLoaded = true;
    }
}

export const saveSkinsJSON = (filename = "data/skins.json") => {
    const dir = filename.substring(0, filename.lastIndexOf("/"));
    if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filename, JSON.stringify({ formatVersion, gameVersion, weapons, skins, prices, bundles, rarities, buddies, sprays, cards, titles, battlepass }, null, 2));
    skinsSaveDirty = false;
}

const debouncedSaveSkinsJSON = () => {
    // Only shard 0 writes to disk — other shards keep in-memory state but
    // don't contend on the shared skins.json file. Shard 0 broadcasts
    // skinsReload when data changes so other shards pick up the new data.
    if (client.shard.ids[0] !== 0) return;

    skinsSaveDirty = true;
    if (skinsSaveTimer) return;
    skinsSaveTimer = setTimeout(() => {
        skinsSaveTimer = null;
        if (skinsSaveDirty) saveSkinsJSON();
    }, SKINS_SAVE_DEBOUNCE_MS);
}

// Force flush pending skins.json writes (call on shutdown, shard 0 only)
export const flushSkinsJSON = () => {
    if (client.shard.ids[0] !== 0) return;
    if (skinsSaveTimer) {
        clearTimeout(skinsSaveTimer);
        skinsSaveTimer = null;
    }
    if (skinsSaveDirty) saveSkinsJSON();
}

export const fetchData = async (types = null, checkVersion = false) => {
    // Fast path: if all data is already loaded and we're not doing a version check,
    // skip the 9 conditional checks entirely.
    if (dataFullyLoaded && !checkVersion && types !== null) {
        // Quick check: do all requested types exist and have the right version?
        const allPresent = types.every(t => t && (typeof t !== 'object' || t.version === gameVersion));
        if (allPresent) return;
    }

    // If a fetchData() is already running, wait for it rather than starting a parallel one.
    if (fetchDataPromise) return fetchDataPromise;

    fetchDataPromise = _fetchDataImpl(types, checkVersion);
    try {
        await fetchDataPromise;
    } finally {
        fetchDataPromise = null;
    }
}

const _fetchDataImpl = async (types = null, checkVersion = false) => {
    try {
        if (checkVersion || !gameVersion) {
            gameVersion = (await getValorantVersion()).manifestId;
            await loadSkinsJSON();
        }

        if (types === null) types = [skins, prices, bundles, rarities, buddies, cards, sprays, titles, battlepass];

        const promises = [];

        if (types.includes(skins) && (!skins || skins.version !== gameVersion)) promises.push(getSkinList(gameVersion));
        // Prices are now collected gradually from shop data, just ensure prices object exists
        if (types.includes(prices) && !prices) promises.push(getPrices(gameVersion));
        if (types.includes(bundles) && (!bundles || bundles.version !== gameVersion)) promises.push(getBundleList(gameVersion));
        if (types.includes(rarities) && (!rarities || rarities.version !== gameVersion)) promises.push(getRarities(gameVersion));
        if (types.includes(buddies) && (!buddies || buddies.version !== gameVersion)) promises.push(getBuddies(gameVersion));
        if (types.includes(cards) && (!cards || cards.version !== gameVersion)) promises.push(getCards(gameVersion));
        if (types.includes(sprays) && (!sprays || sprays.version !== gameVersion)) promises.push(getSprays(gameVersion));
        if (types.includes(titles) && (!titles || titles.version !== gameVersion)) promises.push(getTitles(gameVersion));
        if (types.includes(battlepass) && (!battlepass || battlepass.version !== gameVersion)) promises.push(fetchBattlepassInfo(gameVersion));

        // Removed: 24h price refresh - prices now collected gradually from shop/bundle data

        if (promises.length === 0) {
            // All requested types already loaded — mark as fully loaded if all 9 types are present
            if (skins && prices && bundles && rarities && buddies && cards && sprays && titles && battlepass) {
                dataFullyLoaded = true;
            }
            return;
        }
        await Promise.all(promises);

        // Check if all data types are now present
        if (skins && prices && bundles && rarities && buddies && cards && sprays && titles && battlepass) {
            dataFullyLoaded = true;
        }

        saveSkinsJSON();

        // we fetched the skins, tell other shards to load them
        sendShardMessage({ type: "skinsReload" });
    } catch (e) {
        console.error("There was an error while trying to fetch skin data!");
        console.error(e);
    }
}

export const getSkinList = async (gameVersion) => {
    console.log("Fetching valorant skin list...");

    const req = await fetch("https://valorant-api.com/v1/weapons?language=all");
    console.assert(req.statusCode === 200, `Valorant skins status code is ${req.statusCode}!`, req);

    const json = JSON.parse(req.body);
    console.assert(json.status === 200, `Valorant skins data status code is ${json.status}!`, json);

    skins = { version: gameVersion };
    weapons = {};
    for (const weapon of json.data) {
        weapons[weapon.uuid] = {
            uuid: weapon.uuid,
            names: weapon.displayName,
            icon: weapon.displayIcon,
            defaultSkinUuid: weapon.defaultSkinUuid,
        }
        for (const skin of weapon.skins) {
            const levelOne = skin.levels[0];

            let icon;
            if (skin.themeUuid === "5a629df4-4765-0214-bd40-fbb96542941f") { // default skins
                icon = skin.chromas[0] && skin.chromas[0].fullRender;
            } else {
                for (let i = 0; i < skin.levels.length; i++) {
                    if (skin.levels[i] && skin.levels[i].displayIcon) {
                        icon = skin.levels[i].displayIcon;
                        break;
                    }
                }
            }
            if (!icon) icon = null;
            skins[levelOne.uuid] = {
                uuid: levelOne.uuid,
                skinUuid: skin.uuid,
                weapon: weapon.uuid,
                names: skin.displayName,
                icon: icon,
                rarity: skin.contentTierUuid,
                defaultSkinUuid: weapon.defaultSkinUuid,
                levels: skin.levels,
                chromas: skin.chromas,
            }
        }
    }

    // saveSkinsJSON() deferred to fetchData() caller
}

const getPrices = async (gameVersion, id = null) => {
    if (!config.fetchSkinPrices) return;

    // Prices are now collected gradually from shop/bundle data
    // Just ensure prices object exists with version
    if (!prices || !prices.version) {
        prices = { version: gameVersion, timestamp: Date.now() };
        // saveSkinsJSON() deferred to fetchData() caller
    }

    return true;
}

// Collect prices from storefront data (SingleItemStoreOffers, bundles, etc.)
// Called whenever a user fetches their shop
export const addPricesFromShop = (shopJson) => {
    if (!config.fetchSkinPrices) return;

    let newPrices = 0;
    const vpCurrencyId = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741"; // VP currency UUID

    // Initialize prices if needed
    if (!prices || typeof prices !== 'object') {
        prices = { timestamp: Date.now() };
    }

    // Extract from SingleItemStoreOffers (daily shop items with full price data)
    if (shopJson.SkinsPanelLayout?.SingleItemStoreOffers) {
        for (const offer of shopJson.SkinsPanelLayout.SingleItemStoreOffers) {
            if (offer.OfferID && offer.Cost && !prices[offer.OfferID]) {
                // Get VP cost (most common currency)
                const cost = offer.Cost[vpCurrencyId] || offer.Cost[Object.keys(offer.Cost)[0]];
                if (cost) {
                    prices[offer.OfferID] = cost;
                    newPrices++;
                }
            }
        }
    }

    // Extract from bundles
    if (shopJson.FeaturedBundle?.Bundles) {
        for (const bundle of shopJson.FeaturedBundle.Bundles) {
            if (bundle.ItemOffers) {
                for (const itemOffer of bundle.ItemOffers) {
                    const offer = itemOffer.Offer;
                    if (offer?.OfferID && offer?.Cost && !prices[offer.OfferID]) {
                        const cost = offer.Cost[vpCurrencyId] || offer.Cost[Object.keys(offer.Cost)[0]];
                        if (cost) {
                            prices[offer.OfferID] = cost;
                            newPrices++;
                        }
                    }
                }
            }
            // Also check Items array for base prices
            if (bundle.Items) {
                for (const item of bundle.Items) {
                    if (item.Item?.ItemID && item.BasePrice && !prices[item.Item.ItemID]) {
                        prices[item.Item.ItemID] = item.BasePrice;
                        newPrices++;
                    }
                }
            }
        }
    }

    // Extract from night market if available
    if (shopJson.BonusStore?.BonusStoreOffers) {
        for (const bonusOffer of shopJson.BonusStore.BonusStoreOffers) {
            const offer = bonusOffer.Offer;
            if (offer?.OfferID && offer?.Cost && !prices[offer.OfferID]) {
                const cost = offer.Cost[vpCurrencyId] || offer.Cost[Object.keys(offer.Cost)[0]];
                if (cost) {
                    prices[offer.OfferID] = cost;
                    newPrices++;
                }
            }
        }
    }

    if (newPrices > 0) {
        prices.timestamp = Date.now();
        allSkinsCache = null; // invalidate since prices changed
        console.log(`Added ${newPrices} new skin prices to cache! (Total: ${Object.keys(prices).length - 2} prices)`);

        if (client.shard.ids[0] !== 0) {
            // Non-zero shards: send discovered prices to shard 0 for persistence
            const newPriceData = {};
            if (shopJson.SkinsPanelLayout?.SingleItemStoreOffers) {
                for (const offer of shopJson.SkinsPanelLayout.SingleItemStoreOffers) {
                    if (offer.OfferID && prices[offer.OfferID]) {
                        newPriceData[offer.OfferID] = prices[offer.OfferID];
                    }
                }
            }
            sendShardMessage({ type: "priceUpdate", prices: newPriceData });
        } else {
            // Shard 0 (or non-sharded): save to disk and notify other shards
            debouncedSaveSkinsJSON();
            sendShardMessage({ type: "skinsReload" });
        }
    }
}

// Merge price data received from another shard (called on shard 0)
export const mergePrices = (incomingPrices) => {
    if (!prices || typeof prices !== 'object') {
        prices = { timestamp: Date.now() };
    }
    let merged = 0;
    for (const [uuid, price] of Object.entries(incomingPrices)) {
        if (!prices[uuid]) {
            prices[uuid] = price;
            merged++;
        }
    }
    if (merged > 0) {
        prices.timestamp = Date.now();
        allSkinsCache = null;
        console.log(`Merged ${merged} prices from another shard (Total: ${Object.keys(prices).length - 2} prices)`);
        debouncedSaveSkinsJSON();
        sendShardMessage({ type: "skinsReload" });
    }
}

const buildBundleItemPrices = () => {
    bundleItemPrices = {};
    if (!bundles) return;
    for (const bundle of Object.values(bundles)) {
        if (!bundle.items) continue;
        for (const item of bundle.items) {
            if (item.uuid && item.price) bundleItemPrices[item.uuid] = item.price;
        }
    }
}

const getBundleList = async (gameVersion) => {
    console.log("Fetching valorant bundle list...");

    const req = await fetch("https://valorant-api.com/v1/bundles?language=all");
    console.assert(req.statusCode === 200, `Valorant bundles status code is ${req.statusCode}!`, req);

    const json = JSON.parse(req.body);
    console.assert(json.status === 200, `Valorant bundles data status code is ${json.status}!`, json);

    bundles = { version: gameVersion };
    bundleItemPrices = {}; // items are all null at this point; index rebuilt via addBundleData()
    for (const bundle of json.data) {
        bundles[bundle.uuid] = {
            uuid: bundle.uuid,
            names: bundle.displayName,
            subNames: bundle.displayNameSubText,
            descriptions: bundle.extraDescription,
            icon: bundle.displayIcon,
            items: null,
            price: null,
            basePrice: null,
            expires: null,
            last_seen: null
        }
    }

    // saveSkinsJSON() deferred to fetchData() caller
}

export const addBundleData = async (bundleData) => {
    await fetchData([bundles]);

    let bundle = bundles[bundleData.uuid];
    if (!bundle) {
        bundle = {
            uuid: bundleData.uuid,
            names: { "en-US": "Unknown Bundle (" + bundleData.uuid.substring(0, 8) + ")" },
            subNames: null,
            descriptions: null,
            icon: "https://media.valorant-api.com/bundles/" + bundleData.uuid + "/displayicon.png",
            items: null,
            price: null,
            basePrice: null,
            expires: null,
            last_seen: null
        };
        bundles[bundleData.uuid] = bundle;
        console.log(`Created skeleton for unrecognized bundle ${bundleData.uuid}`);
    }

    bundle.items = bundleData.items.map(item => {
        return {
            uuid: item.uuid,
            type: item.type,
            price: item.price,
            basePrice: item.basePrice,
            discount: item.discount,
            amount: item.amount
        }
    });
    bundle.price = bundleData.price;
    bundle.basePrice = bundleData.basePrice;
    bundle.expires = bundleData.expires;

    // Update inverted price index for this bundle's items
    for (const item of bundle.items) {
        if (item.uuid && item.price) bundleItemPrices[item.uuid] = item.price;
    }

    debouncedSaveSkinsJSON();
}

const getRarities = async (gameVersion) => {
    if (!config.fetchSkinRarities) return false;

    console.log("Fetching skin rarities list...");

    const req = await fetch("https://valorant-api.com/v1/contenttiers/");
    console.assert(req.statusCode === 200, `Valorant rarities status code is ${req.statusCode}!`, req);

    const json = JSON.parse(req.body);
    console.assert(json.status === 200, `Valorant rarities data status code is ${json.status}!`, json);

    rarities = { version: gameVersion };
    for (const rarity of json.data) {
        rarities[rarity.uuid] = {
            uuid: rarity.uuid,
            name: rarity.devName,
            icon: rarity.displayIcon
        }
    }

    // saveSkinsJSON() deferred to fetchData() caller

    return true;
}

export const getBuddies = async (gameVersion) => {
    console.log("Fetching gun buddies list...");

    const req = await fetch("https://valorant-api.com/v1/buddies?language=all");
    console.assert(req.statusCode === 200, `Valorant buddies status code is ${req.statusCode}!`, req);

    const json = JSON.parse(req.body);
    console.assert(json.status === 200, `Valorant buddies data status code is ${json.status}!`, json);

    buddies = { version: gameVersion };
    for (const buddy of json.data) {
        const levelOne = buddy.levels[0];
        buddies[levelOne.uuid] = {
            uuid: levelOne.uuid,
            names: buddy.displayName,
            icon: levelOne.displayIcon
        }
    }

    // saveSkinsJSON() deferred to fetchData() caller
}

export const getCards = async (gameVersion) => {
    console.log("Fetching player cards list...");

    const req = await fetch("https://valorant-api.com/v1/playercards?language=all");
    console.assert(req.statusCode === 200, `Valorant cards status code is ${req.statusCode}!`, req);

    const json = JSON.parse(req.body);
    console.assert(json.status === 200, `Valorant cards data status code is ${json.status}!`, json);

    cards = { version: gameVersion };
    for (const card of json.data) {
        cards[card.uuid] = {
            uuid: card.uuid,
            names: card.displayName,
            icons: {
                small: card.smallArt,
                wide: card.wideArt,
                large: card.largeArt
            }
        }
    }

    // saveSkinsJSON() deferred to fetchData() caller
}

export const getSprays = async (gameVersion) => {
    console.log("Fetching sprays list...");

    const req = await fetch("https://valorant-api.com/v1/sprays?language=all");
    console.assert(req.statusCode === 200, `Valorant sprays status code is ${req.statusCode}!`, req);

    const json = JSON.parse(req.body);
    console.assert(json.status === 200, `Valorant sprays data status code is ${json.status}!`, json);

    sprays = { version: gameVersion };
    for (const spray of json.data) {
        sprays[spray.uuid] = {
            uuid: spray.uuid,
            names: spray.displayName,
            icon: spray.fullTransparentIcon || spray.displayIcon
        }
    }

    // saveSkinsJSON() deferred to fetchData() caller
}

export const getTitles = async (gameVersion) => {
    console.log("Fetching player titles list...");

    const req = await fetch("https://valorant-api.com/v1/playertitles?language=all");
    console.assert(req.statusCode === 200, `Valorant titles status code is ${req.statusCode}!`, req);

    const json = JSON.parse(req.body);
    console.assert(json.status === 200, `Valorant titles data status code is ${json.status}!`, json);

    titles = { version: gameVersion };
    for (const title of json.data) {
        titles[title.uuid] = {
            uuid: title.uuid,
            names: title.displayName,
            text: title.titleText
        }
    }

    // saveSkinsJSON() deferred to fetchData() caller
}

export const fetchBattlepassInfo = async (gameVersion) => {
    console.log("Fetching battlepass UUID and end date...");

    // terminology for this function:
    // act = one in-game period with one battlepass, usually around 2 months
    // episode = 3 acts
    // season = both act and episode. basically any "event" with a start and end date.

    // fetch seasons data (current act end date)
    const req1 = await fetch("https://valorant-api.com/v1/seasons");
    console.assert(req1.statusCode === 200, `Valorant seasons status code is ${req1.statusCode}!`, req1);

    const seasons_json = JSON.parse(req1.body);
    console.assert(seasons_json.status === 200, `Valorant seasons data status code is ${seasons_json.status}!`, seasons_json);

    // fetch battlepass data (battlepass uuid)
    const req2 = await fetch("https://valorant-api.com/v1/contracts");
    console.assert(req2.statusCode === 200, `Valorant contracts status code is ${req2.statusCode}!`, req2);

    const contracts_json = JSON.parse(req2.body);
    console.assert(contracts_json.status === 200, `Valorant contracts data status code is ${contracts_json.status}!`, contracts_json);

    // we need to find the "current battlepass season" i.e. the last season to have a battlepass.
    // it's not always the current season, since between acts there is sometimes a period during
    // server maintenance where the new act has started but there is no battlepass contract for it yet.

    // get all acts
    // const seasonUuids = seasons_json.data.filter(season => season.type === "EAresSeasonType::Act").map(season => season.uuid);
    const all_acts = seasons_json.data.filter(season => season.type === "EAresSeasonType::Act");
    // sort them by start date (oldest first)
    all_acts.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    // and reverse
    all_acts.reverse();
    // we sort then reverse instead of just sorting the other way round directly, because most likely
    // the acts are already sorted beforehand, so this is more efficient.

    // get all battlepass contracts
    const all_bp_contracts = contracts_json.data.filter(contract => contract.content.relationType === "Season");

    // find the last act that has a battlepass
    let currentSeason = null;
    let currentBattlepass = null;
    for (const act of all_acts) {
        const bp_contract = all_bp_contracts.find(contract => contract.content.relationUuid === act.uuid);
        if (bp_contract) {
            currentSeason = act;
            currentBattlepass = bp_contract;
            break;
        }
    }

    // save data
    battlepass = {
        version: gameVersion,
        uuid: currentBattlepass.uuid,
        end: currentSeason.endTime,
        chapters: currentBattlepass.content.chapters
    }

    // saveSkinsJSON() deferred to fetchData() caller
}

export const getItem = async (uuid, type) => {
    switch (type) {
        case itemTypes.SKIN: return await getSkin(uuid);
        case itemTypes.BUDDY: return await getBuddy(uuid);
        case itemTypes.CARD: return await getCard(uuid);
        case itemTypes.SPRAY: return await getSpray(uuid);
        case itemTypes.TITLE: return await getTitle(uuid);
    }
}

export const getSkin = async (uuid, reloadData = true) => {
    if (reloadData) await fetchData([skins, prices]);

    let skin = skins[uuid];
    if (!skin) return null;

    skin.price = await getPrice(uuid);

    return skin;
}

export const getSkinFromSkinUuid = async (uuid, reloadData = true) => {
    if (reloadData) await fetchData([skins, prices]);

    let skin = Object.values(skins).find(skin => skin.skinUuid === uuid);
    if (!skin) return null;

    skin.price = await getPrice(skin.uuid);

    return skin;
}

export const getWeapon = async (uuid) => {
    await fetchData([skins]);

    return weapons[uuid] || null;
}

export const getPrice = async (uuid) => {
    if (!prices) await fetchData([prices]);

    if (prices[uuid]) return prices[uuid];

    if (!bundles) await fetchData([bundles]);
    if (bundleItemPrices[uuid]) return bundleItemPrices[uuid];

    return null;

}

export const getRarity = async (uuid) => {
    if (!rarities) await fetchData([rarities]);
    if (rarities) return rarities[uuid] || null;
}

export const getAllSkins = async () => {
    // Return cached result if skins haven't changed
    if (allSkinsCache && allSkinsCacheVersion === (skins && skins.version)) {
        return allSkinsCache;
    }
    allSkinsCache = await Promise.all(Object.values(skins).filter(o => typeof o === "object").map(skin => getSkin(skin.uuid, false)));
    allSkinsCacheVersion = skins && skins.version;
    return allSkinsCache;
}

export const searchSkin = async (query, locale, limit = 20, threshold = -5000) => {
    await fetchData([skins, prices]);

    const valLocale = discToValLang[locale];
    const keys = [`names.${valLocale}`];
    if (valLocale !== DEFAULT_VALORANT_LANG) keys.push(`names.${DEFAULT_VALORANT_LANG}`);

    const allSkins = await getAllSkins()
    return fuzzysort.go(query, allSkins, {
        keys: keys,
        limit: limit,
        threshold: threshold,
        all: true
    });
}

export const getBundle = async (uuid) => {
    await fetchData([bundles]);
    if (bundles[uuid]) return bundles[uuid];

    if (Date.now() - lastBundleFetch > 60 * 60 * 1000) {
        // UUID not in cache — bundle list is likely stale (new Riot bundle). Force a re-fetch.
        console.log(`[getBundle] UUID ${uuid} not found in bundle cache, forcing re-fetch...`);
        bundles = null;
        dataFullyLoaded = false;
        await fetchData([bundles]);
        lastBundleFetch = Date.now();
    }
    return bundles[uuid];
}

export const getAllBundles = () => {
    // reverse the array so that the older bundles are first
    return Object.values(bundles).reverse().filter(o => typeof o === "object")
}

export const searchBundle = async (query, locale, limit = 20, threshold = -1000) => {
    await fetchData([bundles]);

    const valLocale = discToValLang[locale];
    const keys = [`names.${valLocale}`];
    if (valLocale !== DEFAULT_VALORANT_LANG) keys.push(`names.${DEFAULT_VALORANT_LANG}`);

    return fuzzysort.go(query, getAllBundles(), {
        keys: keys,
        limit: limit,
        threshold: threshold,
        all: true
    });
}

export const getBuddy = async (uuid) => {
    if (!buddies) await fetchData([buddies]);
    return buddies[uuid];
}

export const getSpray = async (uuid) => {
    if (!sprays) await fetchData([sprays]);
    return sprays[uuid];
}

export const getCard = async (uuid) => {
    if (!cards) await fetchData([cards]);
    return cards[uuid];
}

export const getTitle = async (uuid) => {
    if (!titles) await fetchData([titles]);
    return titles[uuid];
}

export const getBattlepassInfo = async () => {
    if (!battlepass) await fetchData([battlepass]);
    return battlepass;
}
