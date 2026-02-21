import fs from "fs";
import {BaseInteraction} from "discord.js";
import {getSetting} from "./settings.js";
import {getUser, User} from "../valorant/auth.js";
import config from "./config.js";

// languages valorant doesn't have:
// danish, croatian, lithuanian, hungarian, dutch, norwegian, romanian, finnish, swedish, czech, greek, bulgarian, ukranian, hindi
// languages discord doesn't have:
// arabic, mexican spanish, indonesian
export const discToValLang = {
    'de'   : 'de-DE',
    'en-GB': 'en-US', // :(
    'en-US': 'en-US',
    'es-ES': 'es-ES',
    'fr'   : 'fr-FR',
    'it'   : 'it-IT',
    'pl'   : 'pl-PL',
    'pt-BR': 'pt-BR',
    'vi'   : 'vi-VN',
    'tr'   : 'tr-TR',
    'ru'   : 'ru-RU',
    'th'   : 'th-TH',
    'zh-CN': 'zh-CN',
    'ja'   : 'ja-JP',
    'zh-TW': 'zh-TW',
    'ko'   : 'ko-KR',

    // valorant languages, that discord doesn't support
    'ar-AE': 'ar-AE',
    'es-MX': 'es-MX',
    'id-ID': 'id-ID'
}

export const valToDiscLang = {};
Object.keys(discToValLang).forEach(discLang => {
    valToDiscLang[discToValLang[discLang]] = discLang;
});

export const discLanguageNames = {
    'de'   : '🇳🇱 Deutsch',
    'en-GB': '🇬🇧 English (UK)',
    'en-US': '🇺🇸 English (US)',
    'es-ES': '🇪🇸 Español',
    'fr'   : '🇫🇷 Français',
    'it'   : '🇮🇹 Italiano',
    'pl'   : '🇵🇱 Polski',
    'pt-BR': '🇧🇷 Português (Brasil)',
    'vi'   : '🇻🇳 Tiếng Việt',
    'tr'   : '🇹🇷 Türkçe',
    'ru'   : '🇷🇺 Русский',
    'th'   : '🇹🇭 ไทย',
    'zh-CN': '🇨🇳 简体中文',
    'ja'   : '🇯🇵 日本語',
    'zh-TW': '🇹🇼 繁體中文',
    'ko'   : '🇰🇷 한국어',

    // valorant languages, that discord doesn't support
    'ar-AE': '🇸🇦 العربية',
    'es-MX': '🇲🇽 Español (México)',
    'id-ID': '🇮🇩 Bahasa Indonesia',

    // languages that neither discord nor valorant support
    'tl-PH': '🇵🇭 Tagalog',
}

export const DEFAULT_LANG = 'en-GB';
export const DEFAULT_VALORANT_LANG = 'en-US';

const languages = {};

// asLocalized returns a plain string primitive so Discord.js component
// builders (which check typeof === 'string') always accept the value.
// .f() template formatting is available via String.prototype.f (see below).
const asLocalized = (value) => typeof value === 'string' ? value : String(value);

const buildCategoryProxy = (categoryStrings = {}, fallbackCategory = null) => new Proxy(categoryStrings, {
    get: (target, prop) => {
        if(prop in target) return asLocalized(target[prop]);

        if(fallbackCategory && prop in fallbackCategory) {
            return asLocalized(fallbackCategory[prop]);
        }

        return prop;
    }
});

const importLanguage = (language) => {
    let languageStrings;
    try {
        languageStrings = JSON.parse(fs.readFileSync(`./languages/${language}.json`, 'utf-8'));
    } catch (e) {
        if(language === DEFAULT_LANG) console.error(`Couldn't load ${DEFAULT_LANG}.json! Things will break.`);
        return;
    }

    const languageHandler = {};
    for(const category in languageStrings) {
        if(typeof languageStrings[category] !== 'object') continue;
        const fallbackCategory = language === DEFAULT_LANG ? null : languages[DEFAULT_LANG][category];
        languageHandler[category] = buildCategoryProxy(languageStrings[category], fallbackCategory);
    }

    if(language !== DEFAULT_LANG) {
        for(const category in languages[DEFAULT_LANG]) {
            if(!languageHandler[category]) languageHandler[category] = languages[DEFAULT_LANG][category];
        }
    }

    languages[language] = languageHandler;
}
importLanguage(DEFAULT_LANG);

export const formatString = (template, args, interactionOrId=null, hideName=true) => {
    args = hideUsername(args, interactionOrId, hideName);
    let str = template;
    for(let i in args)
        str = str.replace(`{${i}}`, args[i]);
    return str;
}

// Attach .f() to String.prototype so that locale strings returned as
// plain primitives (typeof === 'string') still support .f({key: val})
// template formatting throughout the codebase.
if(!String.prototype.f) {
    Object.defineProperty(String.prototype, 'f', {
        value: function(args, interactionOrId=null, hideName=true) {
            return formatString(this.toString(), args, interactionOrId, hideName);
        },
        writable: true,
        configurable: true,
        enumerable: false,
    });
}

// get the strings for a language
export const s = (input) => {
    // Fast path: if we already resolved the language for this interaction/user, reuse it
    if (input && typeof input === 'object' && input._skinpeekLang) return input._skinpeekLang;

    const discLang = config.localiseText ? resolveDiscordLanguage(input) : DEFAULT_LANG;

    if(!languages[discLang]) importLanguage(discLang);
    const result = languages[discLang] || languages[DEFAULT_LANG];

    // Cache on the interaction/user object to avoid re-resolving
    if (input && typeof input === 'object') {
        try { input._skinpeekLang = result; } catch(e) { /* frozen object, ignore */ }
    }

    return result;
}

// get the skin/bundle name in a language
export const l = (names, input) => {
    let discLocale = config.localiseSkinNames ? resolveDiscordLanguage(input) : DEFAULT_LANG;
    let valLocale = discToValLang[discLocale];
    return names[valLocale] || names[DEFAULT_VALORANT_LANG];
}

// input can be a valorant user, an interaction, a discord id, a language code, or null
const resolveDiscordLanguage = (input) => {
    let discLang;

    if(!input) discLang = DEFAULT_LANG;
    if(typeof input === 'string') {
        const user = getUser(input);
        if(user) input = user;
        else discLang = input;
    }
    if(input instanceof User) discLang = getSetting(input.id, 'locale');
    if(input instanceof BaseInteraction) discLang = getSetting(input.user.id, 'locale');

    if(discLang === "Automatic") discLang = input.locale;
    if(!discLang) discLang = DEFAULT_LANG;

    return discLang;
}

export const hideUsername = (args, interactionOrId, hideName = true) => {
    if(!args.u) return {...args, u: s(interactionOrId).info.NO_USERNAME};
    if(!interactionOrId) return args;

    const id = typeof interactionOrId === 'string' ? interactionOrId : interactionOrId.user.id;
    const hide = hideName ? getSetting(id, 'hideIgn') : false;
    if(!hide) return args;

    return {...args, u: `||*${s(interactionOrId).info.HIDDEN_USERNAME}*||`};
}
