import fs from "fs";
import { BaseInteraction } from "discord.js";
import { getUserFromDb } from "./userDatabase.js";
import config from "./config.js";

// languages valorant doesn't have (fetch skins in en-US):
// danish, croatian, lithuanian, hungarian, dutch, norwegian, romanian, finnish, swedish, czech, greek, bulgarian, ukranian, hindi
// languages discord doesn't have:
// arabic, mexican spanish, indonesian
export const discToValLang = {
    'de': 'de-DE',
    'en-GB': 'en-US',
    'en-US': 'en-US',
    'es-ES': 'es-ES',
    'es-419': 'es-MX',
    'fr': 'fr-FR',
    'it': 'it-IT',
    'pl': 'pl-PL',
    'pt-BR': 'pt-BR',
    'vi': 'vi-VN',
    'tr': 'tr-TR',
    'ru': 'ru-RU',
    'th': 'th-TH',
    'zh-CN': 'zh-CN',
    'ja': 'ja-JP',
    'zh-TW': 'zh-TW',
    'ko': 'ko-KR',
    'id': 'id-ID',

    // Discord locales that Valorant doesn't have
    'da': 'en-US',
    'hr': 'en-US',
    'lt': 'en-US',
    'hu': 'en-US',
    'nl': 'en-US',
    'no': 'en-US',
    'ro': 'en-US',
    'fi': 'en-US',
    'sv-SE': 'en-US',
    'cs': 'en-US',
    'el': 'en-US',
    'bg': 'en-US',
    'uk': 'en-US',
    'hi': 'en-US',

    // valorant languages that discord doesn't support
    'ar-AE': 'ar-AE'
};

export const valToDiscLang = {};
Object.keys(discToValLang).forEach(discLang => {
    valToDiscLang[discToValLang[discLang]] = discLang;
});

export const discLanguageNames = {
    'de': '🇩🇪 Deutsch',
    'en-GB': '🇬🇧 English (UK)',
    'en-US': '🇺🇸 English (US)',
    'es-ES': '🇪🇸 Español',
    'es-419': '🇲🇽 Español (Latinoamérica)',
    'fr': '🇫🇷 Français',
    'it': '🇮🇹 Italiano',
    'pl': '🇵🇱 Polski',
    'pt-BR': '🇧🇷 Português (Brasil)',
    'vi': '🇻🇳 Tiếng Việt',
    'tr': '🇹🇷 Türkçe',
    'ru': '🇷🇺 Русский',
    'th': '🇹🇭 ไทย',
    'zh-CN': '🇨🇳 简体中文',
    'ja': '🇯🇵 日本語',
    'zh-TW': '🇹🇼 繁體中文',
    'ko': '🇰🇷 한국어',
    'id': '🇮🇩 Bahasa Indonesia',

    // Discord locales that Valorant doesn't have
    'da': '🇩🇰 Dansk',
    'hr': '🇭🇷 Hrvatski',
    'lt': '🇱🇹 Lietuvių',
    'hu': '🇭🇺 Magyar',
    'nl': '🇳🇱 Nederlands',
    'no': '🇳🇴 Norsk',
    'ro': '🇷🇴 Română',
    'fi': '🇫🇮 Suomi',
    'sv-SE': '🇸🇪 Svenska',
    'cs': '🇨🇿 Čeština',
    'el': '🇬🇷 Ελληνικά',
    'bg': '🇧🇬 Български',
    'uk': '🇺🇦 Українська',
    'hi': '🇮🇳 हिन्दी',

    // valorant languages that discord doesn't support
    'ar-AE': '🇸🇦 العربية',

    // languages that neither discord nor valorant support
    'tl-PH': '🇵🇭 Tagalog',
};

export const DEFAULT_LANG = 'en-GB';
export const DEFAULT_VALORANT_LANG = 'en-US';

export const formatString = (s) => {
    if (typeof s !== "string") return s;

    String.prototype.f = function (args, fallbackString) {
        let str = this;
        if (args) {
            for (let key in args) {
                str = str.replaceAll(`{${key}}`, args[key]);
            }
        }
        if (fallbackString && str.includes("{") && str.includes("}")) return fallbackString;
        return str;
    };

    return s;
};

const asLocalized = (value) => {
    if (typeof value === "string") return formatString(value);
    return value;
};

const buildCategoryProxy = (categoryStrings = {}, fallbackCategory = null) => {
    const target = (categoryStrings && typeof categoryStrings === "object") ? categoryStrings : {};
    return new Proxy(target, {
        get(targetObj, prop) {
            if (prop in targetObj) return asLocalized(targetObj[prop]);
            if (fallbackCategory && prop in fallbackCategory) return asLocalized(fallbackCategory[prop]);
            return formatString(prop);
        }
    });
};

const languages = {};
export const loadLanguages = () => {
    for (const language in discLanguageNames) {
        try {
            const languageStrings = JSON.parse(fs.readFileSync(`languages/${language}.json`, 'utf-8'));
            const languageHandler = {};

            for (const category in languageStrings) {
                const fallbackCategory = language === DEFAULT_LANG ? null : languages[DEFAULT_LANG]?.[category];
                languageHandler[category] = buildCategoryProxy(languageStrings[category], fallbackCategory);
            }

            languages[language] = new Proxy(languageHandler, {
                get(target, prop) {
                    if (prop in target) return target[prop];
                    const fallbackCategory = language === DEFAULT_LANG ? null : languages[DEFAULT_LANG]?.[prop];
                    return buildCategoryProxy({}, fallbackCategory);
                }
            });
        } catch (e) {
            if (language === DEFAULT_LANG) console.error(`Couldn't load ${DEFAULT_LANG} language file!`, e);
        }
    }
};

loadLanguages();

export const hideUsername = (username, hide = true) => {
    if (!hide || !username) return username;
    return username.replace(/#.*$/, "");
};

const getUserSetting = (userId, key, defaultValue = null) => {
    if (!userId) return defaultValue;
    const user = getUserFromDb(userId);
    return user?.settings?.[key] ?? defaultValue;
};

export const s = (input) => {
    let discLang = null;
    let userId = null;

    if (typeof input === "string") {
        if (input in languages) return languages[input];
        userId = input;
    } else if (input instanceof BaseInteraction) {
        userId = input.user?.id;
        discLang = input.locale;
    } else if (input && typeof input === "object") {
        userId = input.id || input.userId;
    }

    if (userId) {
        const userLocale = getUserSetting(userId, 'locale');
        if (userLocale && userLocale !== "Automatic") {
            discLang = userLocale;
        }
    }

    if (!discLang || discLang === "Automatic") {
        discLang = (input instanceof BaseInteraction ? input.locale : null) || DEFAULT_LANG;
    }

    if (discLang in languages) return languages[discLang];
    return languages[DEFAULT_LANG];
};

export const l = (languageObject, input, hideName = false) => {
    if (!languageObject) return "";

    let discLang = null;
    let userId = null;

    if (typeof input === "string") {
        if (input in languages || input in discToValLang) {
            discLang = input;
        } else if (input in languageObject) {
            return formatString(languageObject[input]);
        } else {
            userId = input;
        }
    } else if (input instanceof BaseInteraction) {
        userId = input.user?.id;
    } else if (input && typeof input === "object") {
        userId = input.id || input.userId;
    }

    if (userId) {
        discLang = getUserSetting(userId, 'locale');
    }

    if (!discLang || discLang === "Automatic") {
        if (input instanceof BaseInteraction) discLang = input.locale;
        else discLang = DEFAULT_LANG;
    }

    const valLang = discToValLang[discLang] || (Object.keys(languageObject).includes(discLang) ? discLang : DEFAULT_VALORANT_LANG);
    let str = languageObject[valLang] || languageObject[DEFAULT_VALORANT_LANG] || Object.values(languageObject)[0] || "";

    const hide = hideName ? getUserSetting(userId, 'hideIgn', false) : false;
    return hideUsername(str, hide);
};
