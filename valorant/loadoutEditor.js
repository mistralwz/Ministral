import { fetch, safeJson, userRegion, riotClientHeaders, isMaintenance } from "../misc/util.js";
import { authUser, getUser, deleteUserAuth } from "./auth.js";
import config from "../misc/config.js";

const pd = (user) => `https://pd.${userRegion(user)}.a.pvp.net`;

const headersFor = (user) => ({
    "Authorization": "Bearer " + user.auth.rso,
    "X-Riot-Entitlements-JWT": user.auth.ent,
    ...riotClientHeaders(),
});

const handleErrors = (json) => {
    if (!json) return { success: false, networkError: true };
    if (json.httpStatus === 400 && json.errorCode === "BAD_CLAIMS") return { success: false, authFailure: true };
    if (isMaintenance(json)) return { success: false, maintenance: true };
    return null;
};

export const fetchPlayerLoadoutRaw = async (user) => {
    const req = await fetch(`${pd(user)}/personalization/v2/players/${user.puuid}/playerloadout`, { headers: headersFor(user) });
    return safeJson(req.body);
};

export const setLoadout = async (id, account, newLoadout) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return authResult;
    const user = getUser(id, account);
    if (!user) return { success: false };

    const current = await fetchPlayerLoadoutRaw(user);
    const err = handleErrors(current);
    if (err) return err;

    const merged = { ...current, ...newLoadout };
    const req = await fetch(`${pd(user)}/personalization/v2/players/${user.puuid}/playerloadout`, {
        method: "PUT",
        headers: { ...headersFor(user), "Content-Type": "application/json" },
        body: JSON.stringify(merged)
    });

    const json = safeJson(req.body);
    const putErr = handleErrors(json);
    if (putErr) return putErr;

    const { clearLoadoutCache } = await import("./inventory.js");
    clearLoadoutCache(user.puuid);

    return { success: true };
};

export const equipSkinForWeapon = async (id, account, weaponUuid, skinUuid) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return authResult;
    const user = getUser(id, account);
    if (!user) return { success: false };

    const current = await fetchPlayerLoadoutRaw(user);
    const err = handleErrors(current);
    if (err) return err;

    const guns = current.Guns || [];
    const existingIndex = guns.findIndex(g => g.ID?.toLowerCase() === weaponUuid.toLowerCase());

    const emptyGun = {
        ID: weaponUuid,
        SkinID: skinUuid || weaponUuid,
        ChromaID: skinUuid || weaponUuid,
        CharmID: "",
        CharmLevelID: "",
        Attachments: []
    };

    let gun;
    if (existingIndex >= 0) {
        gun = { ...guns[existingIndex] };
        gun.SkinID = skinUuid;
        gun.ChromaID = skinUuid;
        if (!skinUuid) {
            gun.CharmID = "";
            gun.CharmLevelID = "";
            gun.Attachments = [];
        }
        guns[existingIndex] = gun;
    } else {
        gun = emptyGun;
        guns.push(gun);
    }

    const result = await setLoadout(id, account, { Guns: guns });
    return result.success ? { success: true, gun } : result;
};

export const equipChromaForWeapon = async (id, account, weaponUuid, chromaId) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return authResult;
    const user = getUser(id, account);
    if (!user) return { success: false };

    const current = await fetchPlayerLoadoutRaw(user);
    const err = handleErrors(current);
    if (err) return err;

    const guns = current.Guns || [];
    const idx = guns.findIndex(g => g.ID?.toLowerCase() === weaponUuid.toLowerCase());
    if (idx < 0) return { success: false, error: "no_skin_equipped" };

    guns[idx] = { ...guns[idx], ChromaID: chromaId };
    const result = await setLoadout(id, account, { Guns: guns });
    return result.success ? { success: true } : result;
};

export const getEntitlementsMap = async (user, itemTypeId) => {
    const owned = {};
    let startIndex = 0;
    while (true) {
        const req = await fetch(`${pd(user)}/store/v1/entitlements/${user.puuid}/${itemTypeId}?startIndex=${startIndex}&size=200`, {
            headers: headersFor(user)
        });
        const json = safeJson(req.body);
        const err = handleErrors(json);
        if (err) return err;
        for (const ent of json.Entitlements || []) owned[ent.ItemID?.toLowerCase()] = true;
        if (!json.Entitlements || json.Entitlements.length < 200) break;
        startIndex += 200;
    }
    return { success: true, owned };
};

export const getPlayerCard = async (user) => {
    const req = await fetch(`${pd(user)}/personalization/v2/players/${user.puuid}/playercard`, { headers: headersFor(user) });
    const json = safeJson(req.body);
    const err = handleErrors(json);
    if (err) return err;
    return { success: true, cardId: json.cardId };
};

const PLAYER_CARD_FALLBACK = "f5dd7950-4f39-46ed-96e6-afae38fc0ef3";

export const setPlayerCard = async (id, account, cardId) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return authResult;
    const user = getUser(id, account);
    if (!user) return { success: false };

    const req = await fetch(`${pd(user)}/personalization/v2/players/${user.puuid}/playercard/${cardId || PLAYER_CARD_FALLBACK}`, {
        method: "POST",
        headers: headersFor(user)
    });

    if (req.statusCode !== 200 && req.statusCode !== 204) {
        const json = safeJson(req.body);
        const err = handleErrors(json);
        if (err) return err;
        return { success: false };
    }

    return { success: true };
};
