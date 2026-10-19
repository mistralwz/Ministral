import fs from "fs";
import path from "path";

// The local Riot Client API (the same one the game talks to over localhost).
//
// Friends, presences and crosshair profiles have no remote equivalent - Riot
// only serves them here - so anything using this needs the bot running on the
// machine the Riot Client is installed on. Everything fails soft when it isn't.

const LOCKFILE_PATHS = [
    process.env.RIOT_LOCKFILE,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Riot Games", "Riot Client", "Config", "lockfile"),
    "C:\\Riot Games\\Riot Client\\Config\\lockfile",
].filter(Boolean);

const LOCKFILE_TTL = 30 * 1000;

let cachedLockfile = null;

const readLockfile = () => {
    for (const file of LOCKFILE_PATHS) {
        try {
            // name:pid:port:password:protocol
            const [, , port, password, protocol] = fs.readFileSync(file, "utf8").trim().split(":");
            if (port && password) return { port: Number(port), password, protocol: protocol || "http" };
        } catch {
            // missing, or the client is mid-write and it's not parseable yet
        }
    }
    return null;
};

const getLockfile = () => {
    if (cachedLockfile && Date.now() - cachedLockfile.ts < LOCKFILE_TTL) return cachedLockfile;
    const lockfile = readLockfile();
    cachedLockfile = lockfile ? { ...lockfile, ts: Date.now() } : null;
    return cachedLockfile;
};

export const isLocalClientAvailable = () => getLockfile() !== null;

/**
 * GET/POST against the local client. Returns { success, data } or
 * { success: false, localUnavailable: true } when the client isn't reachable.
 */
export const localRequest = async (endpoint, { method = "GET", body = null, timeout = 5000 } = {}) => {
    const lockfile = getLockfile();
    if (!lockfile) return { success: false, localUnavailable: true };

    try {
        const resp = await fetch(`http://127.0.0.1:${lockfile.port}${endpoint}`, {
            method,
            headers: {
                "Authorization": "Basic " + Buffer.from(`riot:${lockfile.password}`).toString("base64"),
                "Content-Type": "application/json"
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeout)
        });

        if (!resp.ok) return { success: false, statusCode: resp.status };

        const text = await resp.text();
        if (!text) return { success: true, data: null };

        try {
            return { success: true, data: JSON.parse(text) };
        } catch {
            return { success: true, data: null };
        }
    } catch (e) {
        // Connection refused / timed out: the lockfile is stale, the client was
        // closed since we last read it, or something else is on that port.
        cachedLockfile = null;
        return { success: false, localUnavailable: true, error: e.message };
    }
};
