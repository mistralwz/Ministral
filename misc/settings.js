import { getUserFromDb, saveUserToDb } from "./userDatabase.js";
import { discLanguageNames, s, setSettingsProvider } from "./languages.js";

export const settings = {
    dailyShop: {
        set: (value, interaction) => value === 'true' ? interaction.channelId : false,
        render: (value, interaction) => {
            const isChannelId = (v) => !isNaN(parseFloat(v));
            if (isChannelId(value)) return s(interaction).info.ALERT_IN_CHANNEL.f({ c: value });
            return value;
        },
        choices: (interaction) => {
            let channelOption = interaction.channel?.name
                ? s(interaction).info.ALERT_IN_CHANNEL_NAME.f({ c: interaction.channel.name })
                : s(interaction).info.ALERT_IN_DM_CHANNEL;
            return [channelOption, false];
        },
        values: [true, false],
        default: false
    },
    pingOnAutoDailyShop: {
        values: [true, false],
        default: true
    },
    hideIgn: {
        values: [true, false],
        default: false
    },
    othersCanViewShop: {
        values: [true, false],
        default: true
    },
    othersCanViewColl: {
        values: [true, false],
        default: true
    },
    othersCanViewProfile: {
        values: [true, false],
        default: true
    },
    othersCanUseAccountButtons: {
        values: [true, false],
        default: false,
    },
    locale: {
        values: ["Automatic", ...Object.keys(discLanguageNames)],
        default: "Automatic"
    },
    localeForced: {
        hidden: true
    }
};

export const defaultSettings = {};
for (const setting in settings) defaultSettings[setting] = settings[setting].default;

const settingsCache = new Map();

export const getSettings = (id) => {
    if (!id) return defaultSettings;

    if (settingsCache.has(id)) {
        return settingsCache.get(id);
    }

    const json = getUserFromDb(id);
    if (!json) return defaultSettings;

    if (!json.settings) {
        json.settings = defaultSettings;
        saveUserToDb(json);
    } else {
        let changed = false;

        for (const setting in defaultSettings) {
            if (!(setting in json.settings)) {
                json.settings[setting] = defaultSettings[setting];
                changed = true;
            }
        }

        for (const setting in json.settings) {
            if (!(setting in defaultSettings)) {
                delete json.settings[setting];
                changed = true;
            }
        }

        if (changed) saveUserToDb(json);
    }

    settingsCache.set(id, json.settings);
    return json.settings;
};

export const getSetting = (id, setting) => {
    return getSettings(id)[setting];
};

export const clearSettingsCache = (id) => {
    if (id) {
        settingsCache.delete(id);
    } else {
        settingsCache.clear();
    }
};

export const setSetting = async (interaction, setting, value, force = false) => {
    const id = interaction.user.id;
    const json = getUserFromDb(id);
    if (!json) return defaultSettings[setting];

    if (setting === "locale") {
        if (force) {
            json.settings.localeForced = value !== "Automatic";
            json.settings.locale = json.settings.localeForced ? computerifyValue(value) : "Automatic";
        } else if (!json.settings.localeForced) {
            json.settings.locale = value;
        }
    } else {
        let setValue = settings[setting].set ? settings[setting].set(value, interaction) : value;
        json.settings[setting] = computerifyValue(setValue);
    }

    saveUserToDb(json);

    settingsCache.delete(id);
    const { sendShardMessage } = await import("./shardMessage.js");
    await sendShardMessage({ type: "settingsInvalidate", userId: id });

    return json.settings[setting];
};

export const registerInteractionLocale = async (interaction) => {
    const userSettings = getSettings(interaction.user.id);
    if (!userSettings.localeForced && userSettings.locale !== interaction.locale) {
        await setSetting(interaction, "locale", interaction.locale);
    }
};

export const settingName = (setting, interaction) => {
    return s(interaction).settings[setting];
};

export const settingIsVisible = (setting) => {
    return !settings[setting].hidden;
};

export const humanifyValue = (value, setting, interaction, emoji = false) => {
    if (settings[setting].render) value = settings[setting].render(value, interaction);
    if (value === true) return emoji ? '✅' : s(interaction).settings.TRUE;
    if (value === false) return emoji ? '❌' : s(interaction).settings.FALSE;
    if (value === "Automatic") return (emoji ? "🌐 " : '') + s(interaction).settings.AUTO;
    if (Object.keys(discLanguageNames).includes(value)) return discLanguageNames[value];
    return String(value);
};

const computerifyValue = (value) => {
    if (["true", "false"].includes(value)) return value === "true";
    if (!isNaN(parseInt(value, 10)) && value.length < 15) return parseInt(value, 10);
    const langEntry = Object.entries(discLanguageNames).find(([, v]) => v === value);
    if (langEntry) return langEntry[0];
    return value;
};

setSettingsProvider(getSettings);

