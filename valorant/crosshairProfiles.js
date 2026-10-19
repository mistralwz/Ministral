import { localRequest } from "../misc/localClient.js";
import { encodeCrosshairProfile } from "../misc/crosshairCode.js";

// The client keeps every crosshair the player has saved in a single string
// setting, so one request gives us the whole list to share from.

const PROFILE_SETTING = "EAresStringSettingName::SavedCrosshairProfileData";

export const getAccountCrosshairs = async () => {
    const res = await localRequest("/player-preferences/v1/data-json/Ares.PlayerSettings");
    if (!res.success) return res;

    const setting = (res.data?.data?.stringSettings || [])
        .find(entry => entry.settingEnum === PROFILE_SETTING);

    if (!setting?.value) return { success: true, profiles: [], current: null };

    let parsed;
    try {
        parsed = JSON.parse(setting.value);
    } catch {
        return { success: true, profiles: [], current: null };
    }

    const profiles = (parsed.profiles || []).map((profile, index) => ({
        index,
        name: profile.profileName || `Crosshair ${index + 1}`,
        code: encodeCrosshairProfile(profile)
    }));

    return { success: true, profiles, current: parsed.currentProfile ?? null };
};
