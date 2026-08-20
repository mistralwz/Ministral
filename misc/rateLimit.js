import config from "./config.js";

const rateLimits = new Map();

export const checkRateLimit = async (req, url) => {
    let rateLimited = req.statusCode === 429 || req.headers?.location?.startsWith("/auth-error?error=rate_limited");
    if (!rateLimited) try {
        const json = JSON.parse(req.body);
        rateLimited = json.error === "rate_limited";
    } catch (e) {}

    if (rateLimited) {
        let retryAfter = parseInt(req.headers?.['retry-after']) + 1;
        if (retryAfter) {
            console.log(`I am ratelimited at ${url} for ${retryAfter - 1} more seconds!`);
            if (retryAfter > config.rateLimitCap) {
                console.log(`Delay higher than rateLimitCap, setting it to ${config.rateLimitCap} seconds instead`);
                retryAfter = config.rateLimitCap;
            }
        } else {
            retryAfter = config.rateLimitBackoff;
            console.log(`I am temporarily ratelimited at ${url} (no ETA given, waiting ${config.rateLimitBackoff}s)`);
        }

        const retryAt = Date.now() + retryAfter * 1000;
        rateLimits.set(url, retryAt);
        return retryAt;
    }

    return false;
};

export const isRateLimited = async (url) => {
    const retryAt = rateLimits.get(url);

    if (!retryAt) return false;
    if (retryAt < Date.now()) {
        rateLimits.delete(url);
        return false;
    }

    const retryAfter = Math.ceil((retryAt - Date.now()) / 1000);
    console.log(`I am still ratelimited at ${url} for ${retryAfter} more seconds!`);

    return retryAt;
};
