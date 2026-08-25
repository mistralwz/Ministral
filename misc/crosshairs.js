import fs from "fs";
import path from "path";

const DATA_FILE = path.join("data", "crosshairs.json");
const MAX_PER_USER = 10;

let cache = null;

const loadAll = () => {
    if (cache) return cache;
    try {
        cache = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch {
        cache = {};
    }
    return cache;
};

const flush = () => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache ?? {}, null, 2));
};

export const getCrosshairs = (id) => {
    const all = loadAll();
    return all[id] || {};
};

export const saveCrosshair = (id, name, code) => {
    const all = loadAll();
    const mine = (all[id] = all[id] || {});
    if (!mine[name] && Object.keys(mine).length >= MAX_PER_USER) return false;
    mine[name] = { code, savedAt: Date.now() };
    flush();
    return true;
};

export const deleteCrosshair = (id, name) => {
    const all = loadAll();
    if (!all[id]?.[name]) return false;
    delete all[id][name];
    flush();
    return true;
};
