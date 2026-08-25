import { authUser, handleBadClaims, getUser, getPuuid } from "./auth.js";
import {
    fetch,
    isMaintenance,
    isSameDay,
    safeJson,
    userRegion,
    riotClientHeaders,
} from "../misc/util.js";
import { addBundleData, getSkin, getSkinFromSkinUuid, addPricesFromShop, getBundle, getItem } from "./cache.js";
import { addStore } from "../misc/stats.js";
import config from "../misc/config.js";
import { deleteUser, saveUser } from "./accountSwitcher.js";

const memoryShopCache = new Map();

export const formatBundle = async (rawBundle) => {
    const bundle = {
        uuid: rawBundle.DataAssetID,
        expires: Math.floor(Date.now() / 1000) + rawBundle.DurationRemainingInSeconds,
        items: []
    };

    let price = 0;
    let basePrice = 0;
    for (const rawItem of rawBundle.Items) {
        const item = {
            uuid: rawItem.Item.ItemID,
            type: rawItem.Item.ItemTypeID,
            item: await getItem(rawItem.Item.ItemID, rawItem.Item.ItemTypeID),
            amount: rawItem.Item.Amount,
            price: rawItem.DiscountedPrice,
            basePrice: rawItem.BasePrice,
            discount: rawItem.DiscountPercent
        };

        price += item.price;
        basePrice += item.basePrice;
        bundle.items.push(item);
    }

    bundle.price = price;
    bundle.basePrice = basePrice;
    return bundle;
};

export const formatNightMarket = (rawNightMarket) => {
    if (!rawNightMarket) return null;

    return {
        offers: rawNightMarket.BonusStoreOffers.map(offer => ({
            uuid: offer.Offer.OfferID,
            realPrice: offer.Offer.Cost["85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741"],
            nmPrice: offer.DiscountCosts["85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741"],
            percent: offer.DiscountPercent
        })),
        expires: Math.floor(Date.now() / 1000) + rawNightMarket.BonusStoreRemainingDurationInSeconds
    };
};

export const getShop = async (id, account = null) => {
    const authSuccess = await authUser(id, account);
    if (!authSuccess.success) return authSuccess;

    const user = getUser(id, account);
    if (config.logUrls) console.log(`Fetching shop for ${user.username}...`);

    const req = await fetch(`https://pd.${userRegion(user)}.a.pvp.net/store/v3/storefront/${user.puuid}`, {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + user.auth.rso,
            "X-Riot-Entitlements-JWT": user.auth.ent,
            ...riotClientHeaders(),
        },
        body: JSON.stringify({})
    });

    // Riot answers an outage with an HTML error page, not JSON — parsing that
    // unguarded threw out of getShop and took /shop, /alerts and the nightly
    // alert run with it. A body we can't parse is a network error.
    const json = safeJson(req.body);
    if (req.statusCode !== 200 || !json) {
        if (req.statusCode === 429 || json?.httpStatus === 429 || json?.errorCode === "RATE_LIMITED") {
            const retryAfterHeader = req.headers?.['retry-after'];
            const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 30000;
            return { success: false, rateLimit: Date.now() + retryAfter };
        } else if (json?.httpStatus === 400 && json?.errorCode === "BAD_CLAIMS") {
            return await handleBadClaims(user);
        } else if (isMaintenance(json)) return { success: false, maintenance: true };
        return { success: false, networkError: true };
    }

    // A 200 without the shop payload is not a usable shop; callers reach
    // straight into json.SkinsPanelLayout.SingleItemOffers.
    if (!json.SkinsPanelLayout) return { success: false, networkError: true };

    try {
        await addStore(user.puuid, json.SkinsPanelLayout.SingleItemOffers);
    } catch (e) {
        console.error("Error adding shop stats:", e);
    }

    addShopCache(user.puuid, json);
    addPricesFromShop(json);

    Promise.all(json.FeaturedBundle.Bundles.map(rawBundle => formatBundle(rawBundle))).then(async bundles => {
        for (const bundle of bundles)
            await addBundleData(bundle);
    }).catch(e => console.error("Error processing shop bundles:", e?.message || e));

    return { success: true, shop: json };
};

export const getOffers = async (id, account = null) => {
    const puuid = getPuuid(id, account);
    if (!puuid) return { success: false, error: "User not found" };

    const shopCache = await getShopCache(puuid, "offers");
    if (shopCache) return { success: true, cached: true, ...shopCache.offers };

    const resp = await getShop(id, account);
    if (!resp.success) return resp;

    return await easterEggOffers(id, account, {
        success: true,
        offers: resp.shop.SkinsPanelLayout.SingleItemOffers,
        expires: Math.floor(Date.now() / 1000) + resp.shop.SkinsPanelLayout.SingleItemOffersRemainingDurationInSeconds,
        accessory: {
            offers: ((resp.shop.AccessoryStore && resp.shop.AccessoryStore.AccessoryStoreOffers) || []).map(rawAccessory => ({
                cost: rawAccessory.Offer.Cost["85ca954a-41f2-ce94-9b45-8ca3dd39a00d"],
                rewards: rawAccessory.Offer.Rewards,
                contractID: rawAccessory.ContractID
            })),
            expires: Math.floor(Date.now() / 1000) + (resp.shop.AccessoryStore ? resp.shop.AccessoryStore.AccessoryStoreRemainingDurationInSeconds : 0)
        }
    });
};

export const getBundles = async (id, account = null) => {
    const puuid = getPuuid(id, account);
    if (!puuid) return { success: false, error: "User not found" };

    const shopCache = await getShopCache(puuid, "bundles");
    if (shopCache) {
        let complete = true;
        for (const bundleCache of shopCache.bundles) {
            const bundle = await getBundle(bundleCache.uuid);
            if (!bundle || !bundle.items) {
                complete = false;
                break;
            }
        }
        if (complete) return { success: true, bundles: shopCache.bundles };
    }

    const resp = await getShop(id, account);
    if (!resp.success) return resp;

    const formatted = await Promise.all(resp.shop.FeaturedBundle.Bundles.map(rawBundle => formatBundle(rawBundle)));
    return { success: true, bundles: formatted };
};

export const getNightMarket = async (id, account = null) => {
    const puuid = getPuuid(id, account);
    if (!puuid) return { success: false, error: "User not found" };

    const shopCache = await getShopCache(puuid, "night_market");
    if (shopCache) return { success: true, ...shopCache.night_market };

    const resp = await getShop(id, account);
    if (!resp.success) return resp;

    if (!resp.shop.BonusStore) return {
        success: true,
        offers: false
    };

    return { success: true, ...formatNightMarket(resp.shop.BonusStore) };
};

export const getBalance = async (id, account = null) => {
    const authSuccess = await authUser(id, account);
    if (!authSuccess.success) return authSuccess;

    const user = getUser(id, account);
    console.log(`Fetching balance for ${user.username}...`);

    const req = await fetch(`https://pd.${userRegion(user)}.a.pvp.net/store/v1/wallet/${user.puuid}`, {
        headers: {
            "Authorization": "Bearer " + user.auth.rso,
            "X-Riot-Entitlements-JWT": user.auth.ent,
            ...riotClientHeaders(),
        }
    });

    const json = safeJson(req.body);
    if (req.statusCode !== 200 || !json?.Balances) {
        if (json?.httpStatus === 400 && json?.errorCode === "BAD_CLAIMS") {
            return await handleBadClaims(user);
        } else if (isMaintenance(json)) return { success: false, maintenance: true };
        return { success: false, networkError: true };
    }

    return {
        success: true,
        vp: json.Balances["85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741"],
        rad: json.Balances["e59aa87c-4cbf-517a-5983-6e81511be9b7"],
        kc: json.Balances["85ca954a-41f2-ce94-9b45-8ca3dd39a00d"]
    };
};

let nextNMTimestamp = null, nextNMTimestampUpdated = 0;
export const getNextNightMarketTimestamp = async () => {
    if (nextNMTimestampUpdated > Date.now() - 5 * 60 * 1000) return nextNMTimestamp;

    try {
        const req = await fetch("https://gist.githubusercontent.com/mistralwz/17bb10db4bb77df5530024bcb0385042/raw/nmdate.txt");
        const [timestamp] = req.body.split("\n");
        nextNMTimestamp = parseInt(timestamp, 10);
        if (isNaN(nextNMTimestamp) || nextNMTimestamp < Date.now() / 1000) nextNMTimestamp = null;
        nextNMTimestampUpdated = Date.now();
    } catch (e) {
        console.error("Failed to fetch next night market timestamp:", e);
    }
    return nextNMTimestamp;
};

export let NMTimestamp = null;

export const getShopCache = async (puuid, target = "offers", print = true) => {
    if (!config.useShopCache) return null;

    try {
        const shopCache = memoryShopCache.get(puuid);
        if (!shopCache) return null;

        let expiresTimestamp;
        if (target === "offers") expiresTimestamp = shopCache[target].expires;
        else if (target === "night_market") expiresTimestamp = shopCache[target] ? shopCache[target].expires : getMidnightTimestamp(shopCache.timestamp);
        else if (target === "bundles") expiresTimestamp = Math.min(...shopCache.bundles.map(bundle => bundle.expires), get9PMTimetstamp(Date.now()));
        else if (target === "all") {
            const nmExpires = shopCache.night_market ? shopCache.night_market.expires : getMidnightTimestamp(shopCache.timestamp);
            expiresTimestamp = Math.min(shopCache.offers.expires, ...shopCache.bundles.map(bundle => bundle.expires), get9PMTimetstamp(Date.now()), nmExpires);
        }

        if (Date.now() / 1000 > expiresTimestamp) {
            memoryShopCache.delete(puuid);
            return null;
        }

        if (print) console.log(`Fetched shop cache for user ${puuid}`);

        if (!shopCache.offers.accessory) {
            memoryShopCache.delete(puuid);
            return null;
        }

        return shopCache;
    } catch (e) {
        console.error(`Failed to get shop cache for ${puuid}:`, e);
    }
    return null;
};

const addShopCache = async (puuid, shopJson) => {
    if (!config.useShopCache) return;

    const now = Date.now();
    const shopCache = {
        offers: {
            offers: shopJson.SkinsPanelLayout ? shopJson.SkinsPanelLayout.SingleItemOffers : [],
            expires: Math.floor(now / 1000) + (shopJson.SkinsPanelLayout ? shopJson.SkinsPanelLayout.SingleItemOffersRemainingDurationInSeconds : 0),
            accessory: {
                offers: ((shopJson.AccessoryStore && shopJson.AccessoryStore.AccessoryStoreOffers) || []).map(rawAccessory => ({
                    cost: rawAccessory.Offer?.Cost ? rawAccessory.Offer.Cost["85ca954a-41f2-ce94-9b45-8ca3dd39a00d"] : 0,
                    rewards: rawAccessory.Offer?.Rewards || [],
                    contractID: rawAccessory.ContractID
                })),
                expires: Math.floor(now / 1000) + (shopJson.AccessoryStore ? shopJson.AccessoryStore.AccessoryStoreRemainingDurationInSeconds : 0)
            }
        },
        bundles: (shopJson.FeaturedBundle?.Bundles || []).map(rawBundle => ({
            uuid: rawBundle.DataAssetID,
            expires: Math.floor(now / 1000) + rawBundle.DurationRemainingInSeconds,
        })),
        night_market: formatNightMarket(shopJson.BonusStore),
        timestamp: now
    };

    if (shopJson.BonusStore) NMTimestamp = now;

    memoryShopCache.set(puuid, shopCache);
    console.log(`Added shop cache for user ${puuid}`);
};

export const clearShopMemoryCache = async () => {
    const memoryEntries = memoryShopCache.size;
    memoryShopCache.clear();
    console.log(`Cleared shop memory cache (${memoryEntries} entries)`);
};

const getMidnightTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999) / 1000;
};

const get9PMTimetstamp = (timestamp) => {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 20, 59, 59, 999) / 1000;
};

const easterEggOffers = async (id, account, offers) => {
    try {
        const _offers = { ...offers, offers: [...offers.offers] };
        const user = getUser(id, account);

        const sawEasterEgg = isSameDay(user.lastSawEasterEgg, Date.now());
        const isApril1st = new Date().getMonth() === 3 && new Date().getDate() === 1;
        if (isApril1st && !sawEasterEgg) {
            for (const [i, uuid] of Object.entries(_offers.offers)) {
                const skin = await getSkin(uuid);
                const defaultSkin = await getSkinFromSkinUuid(skin.defaultSkinUuid);
                _offers.offers[i] = defaultSkin.uuid;
            }

            user.lastSawEasterEgg = Date.now();
            saveUser(user);
            return _offers;
        }
    } catch (e) {
        console.error("Easter egg error:", e);
    }
    return offers;
};
