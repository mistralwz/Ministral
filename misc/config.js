import fs from "fs";

export let config = {};
export default config;

export const loadConfig = (filename = "config.json", saveAfterLoad = true) => {
    let loadedConfig;

    try {
        loadedConfig = fs.readFileSync(filename, 'utf-8');
    } catch (e) {
        try {
            fs.readFileSync(filename + ".example", 'utf-8');
            console.error(`You forgot to rename ${filename}.example to ${filename}!`);
            console.error(`(Hint: If you can only see ${filename}, try enabling "file name extensions" in file explorer)`)
        } catch (e1) {
            console.error(`Could not find ${filename}!`, e);
        }
        return;
    }

    try {
        loadedConfig = JSON.parse(loadedConfig);
    } catch (e) {
        // Retry once in case the file was read mid-write during a reload
        try {
            const retryContent = fs.readFileSync(filename, 'utf-8');
            loadedConfig = JSON.parse(retryContent);
        } catch (e2) {
            return console.error(`Could not JSON parse ${filename}! Is it corrupt?`, e2);
        }
    }

    if (!loadedConfig.token || loadedConfig.token === "token goes here")
        return console.error("You forgot to put your bot token in config.json!");

    if (loadedConfig.HDevTokenAlert && !loadedConfig.HDevToken) {
        console.error("Looks like you didn't put a HDevToken in config.json!");
        console.error("The /profile command won't work without one. To get a key, see https://discord.gg/B7AarTMZMK");
        console.error("If you don't want to see this notification again, set HDevTokenAlert to false in config.json");
    }

    // to see what these keys do, check here:
    // https://github.com/giorgi-o/SkinPeek/wiki/SkinPeek-Admin-Guide#the-option-list

    applyConfig(loadedConfig, "token", "token goes here");
    applyConfig(loadedConfig, "HDevToken", "");
    applyConfig(loadedConfig, "HDevTokenAlert", true);
    //TODO applyConfig(loadedConfig, "useUnofficialValorantApi", true);
    applyConfig(loadedConfig, "fetchSkinPrices", true);
    applyConfig(loadedConfig, "fetchSkinRarities", true);
    applyConfig(loadedConfig, "localiseText", true);
    applyConfig(loadedConfig, "localiseSkinNames", true);
    applyConfig(loadedConfig, "linkItemImage", true);

    applyConfig(loadedConfig, "refreshSkins", "10 0 0 * * *");
    applyConfig(loadedConfig, "checkGameVersion", "*/15 * * * *");
    applyConfig(loadedConfig, "refreshPrices", "*/30 * * * *");
    applyConfig(loadedConfig, "updateUserAgent", "*/15 * * * *");
    applyConfig(loadedConfig, "delayBetweenAlerts", 5 * 1000);
    applyConfig(loadedConfig, "alertConcurrency", 1); // 1 = sequential (safe default); >1 enables parallel alert checks via p-limit
    applyConfig(loadedConfig, "alertsPerPage", 10);
    applyConfig(loadedConfig, "careerCacheExpiration", 10 * 60 * 1000);
    applyConfig(loadedConfig, "emojiCacheExpiration", 10 * 1000);
    applyConfig(loadedConfig, "loadoutCacheExpiration", 10 * 60 * 1000);
    applyConfig(loadedConfig, "livegamePollingInterval", 5000);
    applyConfig(loadedConfig, "deferInteractions", false);
    applyConfig(loadedConfig, "useShopCache", true);
    applyConfig(loadedConfig, "useLoginQueue", false);
    applyConfig(loadedConfig, "loginQueueInterval", 3000);
    applyConfig(loadedConfig, "loginQueuePollRate", 2000);
    applyConfig(loadedConfig, "authFailureStrikes", 2);
    applyConfig(loadedConfig, "maxAccountsPerUser", 5);
    applyConfig(loadedConfig, "autoRefreshTokens", true);
    applyConfig(loadedConfig, "tokenRefreshBufferMinutes", 5);
    applyConfig(loadedConfig, "rateLimitBackoff", 60);
    applyConfig(loadedConfig, "rateLimitCap", 10 * 60);
    applyConfig(loadedConfig, "shards", "auto");
    applyConfig(loadedConfig, "redisHost", "127.0.0.1");
    applyConfig(loadedConfig, "redisPort", 6379);
    applyConfig(loadedConfig, "redisPassword", "");
    applyConfig(loadedConfig, "redisDb", 0);
    applyConfig(loadedConfig, "trackStoreStats", true);
    applyConfig(loadedConfig, "statsExpirationDays", 14);
    applyConfig(loadedConfig, "statsPerPage", 8);
    applyConfig(loadedConfig, "shardReadyTimeout", 60 * 1000);
    applyConfig(loadedConfig, "autoDeployCommands", true);
    applyConfig(loadedConfig, "ownerId", "");
    applyConfig(loadedConfig, "ownerName", "");
    applyConfig(loadedConfig, "status", "Up and running!");
    applyConfig(loadedConfig, "notice", "");
    applyConfig(loadedConfig, "onlyShowNoticeOnce", true);
    applyConfig(loadedConfig, "maintenanceMode", false);
    applyConfig(loadedConfig, "logToChannel", "");
    applyConfig(loadedConfig, "logFrequency", "*/10 * * * * *");
    applyConfig(loadedConfig, "logUrls", false);
    applyConfig(loadedConfig, "verboseLogging", false);

    if (saveAfterLoad) {
        try {
            saveConfig(filename, config);
        } catch (e) {
            console.error("Warning: Failed to save config after loading. This is usually safe to ignore during shard reloads.");
        }
    }

    return config;
}

export const saveConfig = (filename = "config.json", configToSave) => {
    const payload = JSON.stringify(configToSave || config, null, 2);
    const tmpFile = `${filename}.tmp`;

    try {
        // Write to temp file, then atomically replace
        fs.writeFileSync(tmpFile, payload);
        fs.renameSync(tmpFile, filename);
    } catch (e) {
        console.error(`Failed to save config to ${filename}:`, e);
        // Clean up temp file if it was created
        try {
            if (fs.existsSync(tmpFile)) {
                fs.unlinkSync(tmpFile);
            }
        } catch (cleanupError) {
            // Ignore cleanup errors
        }
        throw e; // Re-throw to let caller know save failed
    }
}

const applyConfig = (loadedConfig, name, defaultValue) => {
    if (loadedConfig[name] === undefined) config[name] = defaultValue;
    else config[name] = loadedConfig[name];
}
