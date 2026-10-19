import { fetch, safeJson, userRegion, isMaintenance } from "../misc/util.js";
import { authUser, getUser } from "./auth.js";
import { getSkin } from "./cache.js";
import { riotAuthHeaders, riotJson } from "./riot.js";

// Riot retired personalization/v2 (404 RESOURCE_NOT_FOUND every shard) - v3 is
// the one that still answers for both reading and writing the loadout.
const loadoutUrl = (user) => `https://pd.${userRegion(user)}.a.pvp.net/personalization/v3/players/${user.puuid}/playerloadout`;

/**
 * Equips `skinUuid` on one weapon (pass nothing to go back to the default).
 *
 * The loadout stores a chroma uuid, not the skin's, so the skin's first chroma
 * travels with it - a gun whose ChromaID matches no chroma of its SkinID comes
 * back as the default gun in game.
 */
export const equipSkinForWeapon = async (id, account, weaponUuid, skinUuid) => {
    const authResult = await authUser(id, account);
    if (!authResult.success) return authResult;

    const user = getUser(id, account);
    if (!user) return { success: false, networkError: true };

    const current = await riotJson(user, loadoutUrl(user), {
        valid: (req, json) => Array.isArray(json?.Guns) || console.error(`[equip] unexpected playerloadout response (${req.statusCode}): ${json?.errorCode || Object.keys(json || {}).join(",")}`),
    });
    if (!current.success) return current;

    const skin = skinUuid ? await getSkin(skinUuid) : null;
    const chromaId = skin?.chromas?.[0]?.uuid || skinUuid;

    const guns = current.json.Guns.map(gun => ({ ...gun }));
    const index = guns.findIndex(gun => gun.ID?.toLowerCase() === String(weaponUuid).toLowerCase());

    if (index < 0) {
        guns.push({
            ID: weaponUuid,
            SkinID: skinUuid,
            ChromaID: chromaId,
            CharmID: "",
            CharmLevelID: "",
            Attachments: []
        });
    } else {
        guns[index].SkinID = skinUuid;
        guns[index].ChromaID = chromaId;
        if (!skinUuid) {
            // Going back to the default skin: nothing hangs off the gun any more.
            guns[index].CharmID = "";
            guns[index].CharmLevelID = "";
            guns[index].Attachments = [];
        }
    }

    const put = await fetch(loadoutUrl(user), {
        method: "PUT",
        headers: { ...riotAuthHeaders(user), "Content-Type": "application/json" },
        body: JSON.stringify({ ...current.json, Guns: guns })
    });

    if (put.statusCode !== 200 && put.statusCode !== 204) {
        const json = safeJson(put.body);
        if (json?.httpStatus === 400 && json?.errorCode === "BAD_CLAIMS") return { success: false, authFailure: true };
        if (isMaintenance(json)) return { success: false, maintenance: true };
        console.error(`[equip] loadout write failed (${put.statusCode}): ${json?.errorCode || put.body?.slice(0, 120)}`);
        return { success: false, networkError: true };
    }

    const { clearLoadoutCache } = await import("./inventory.js");
    clearLoadoutCache(user.puuid);

    return { success: true };
};
