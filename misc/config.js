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

    const defaultConfig = {
        token: "token goes here",
        HDevToken: "",
        HDevTokenAlert: true,
        fetchSkinPrices: true,
        fetchSkinRarities: true,
        localiseText: true,
        localiseSkinNames: true,
        linkItemImage: true,
        refreshSkins: "10 0 0 * * *",
        checkGameVersion: "*/15 * * * *",
        refreshPrices: "*/30 * * * *",
        updateUserAgent: "*/15 * * * *",
        delayBetweenAlerts: 5 * 1000,
        alertConcurrency: 1,
        alertsPerPage: 10,
        careerCacheExpiration: 10 * 60 * 1000,
        emojiCacheExpiration: 10 * 1000,
        loadoutCacheExpiration: 10 * 60 * 1000,
        livegamePollingInterval: 8000,
        deferInteractions: false,
        useShopCache: true,
        authFailureStrikes: 2,
        maxAccountsPerUser: 5,
        autoRefreshTokens: true,
        tokenRefreshBufferMinutes: 5,
        rateLimitBackoff: 60,
        rateLimitCap: 10 * 60,
        shards: "auto",
        trackStoreStats: true,
        statsExpirationDays: 14,
        statsPerPage: 8,
        shardReadyTimeout: 60 * 1000,
        autoDeployCommands: true,
        ownerId: "",
        ownerName: "",
        status: "Up and running!",
        notice: "",
        onlyShowNoticeOnce: true,
        maintenanceMode: false,
        logToChannel: "",
        logFrequency: "*/10 * * * * *",
        logUrls: false,
        verboseLogging: false,
    };

    Object.assign(config, defaultConfig, loadedConfig);

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
};
