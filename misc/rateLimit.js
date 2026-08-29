import config from "./config.js";

// Deliberately per-process, not shared across shards via SQLite/IPC: this is
// a "stop hammering a host we personally just got 429'd on" circuit breaker,
// not a correctness requirement like the refresh lock. Sharing it would mean
// every shard talking to every other shard on every request; each shard
// discovering its own 429s independently and backing off is enough to protect
// the one thing that matters (not making a rate limit worse) without adding
// cross-shard chatter for something this cheap to re-learn locally.
const rateLimits = new Map();

/** Has `hostname` told us to back off, and are we still inside that window? */
export const isRateLimited = (hostname) => {
    const retryAt = rateLimits.get(hostname);
    if (!retryAt) return false;
    if (retryAt <= Date.now()) {
        rateLimits.delete(hostname);
        return false;
    }
    return retryAt;
};

/** Inspect a response for a 429/rate-limit shape and remember it if so. */
export const noteRateLimit = (res, hostname) => {
    let bodyRateLimited = false;
    try { bodyRateLimited = JSON.parse(res.body)?.error === "rate_limited"; } catch {}
    if (res.statusCode !== 429 && !bodyRateLimited) return false;

    let retryAfter = parseInt(res.headers?.['retry-after'], 10);
    retryAfter = Number.isFinite(retryAfter) ? retryAfter + 1 : Number(config.rateLimitBackoff) || 30;
    retryAfter = Math.min(retryAfter, Number(config.rateLimitCap) || 3600);

    const retryAt = Date.now() + retryAfter * 1000;
    rateLimits.set(hostname, retryAt);
    console.warn(`[rateLimit] ${hostname} rate-limited us for ${retryAfter}s`);
    return retryAt;
};
