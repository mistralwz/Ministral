import Database from "better-sqlite3";
import { localLog, localError } from "./logger.js";
import { removeDupeAlerts } from "./util.js";

/**
 * @typedef {Object} AuthTokens
 * @property {string} [rso]
 * @property {string} [ent]
 * @property {string} [idt]
 * @property {string} [refresh_token]
 * @property {number} [refresh_token_obtained]
 * @property {string} [cookies]
 */

/**
 * @typedef {Object} AlertItem
 * @property {string} uuid
 * @property {string} channel_id
 */

/**
 * @typedef {Object} AccountData
 * @property {string} id Discord User ID
 * @property {string} puuid Riot PUUID
 * @property {string} username Riot name#tag
 * @property {string} [region]
 * @property {AuthTokens} auth
 * @property {AlertItem[]} alerts
 * @property {number} [authFailures]
 * @property {number} [lastFetchedData]
 * @property {string} [lastNoticeSeen]
 * @property {number} [lastSawEasterEgg]
 */

/**
 * @typedef {Object} UserData
 * @property {string} id
 * @property {AccountData[]} accounts
 * @property {number} currentAccount
 * @property {Record<string, any>} settings
 */

let db = null;
let stmts = {};
let saveUserToDbInTransaction = null;

let batchMode = false;
const batchQueue = new Map();
const batchAccountQueue = new Map();

const safeJsonParse = (value, fallback, context) => {
    try {
        return JSON.parse(value);
    } catch (e) {
        localError(`Failed to parse JSON for ${context}:`, e);
        return fallback;
    }
};

export const initUserDatabase = (dbPath = "data/users.db") => {
    try {
        db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 10000');
        db.pragma('synchronous = NORMAL');
        db.pragma('foreign_keys = ON');

        createTables();
        prepareStatements();
        saveUserToDbInTransaction = db.transaction(saveUserToDbTransaction);
        localLog(`User database initialized at ${dbPath}`);
        return true;
    } catch (e) {
        localError("Failed to initialize user database:", e);
        return false;
    }
};

const createTables = () => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            currentAccount INTEGER NOT NULL DEFAULT 1,
            settings TEXT NOT NULL,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
            puuid TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            username TEXT NOT NULL,
            region TEXT,
            auth TEXT NOT NULL,
            alerts TEXT,
            authFailures INTEGER DEFAULT 0,
            lastFetchedData INTEGER,
            lastNoticeSeen TEXT,
            lastSawEasterEgg INTEGER DEFAULT 0,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL,
            FOREIGN KEY(userId) REFERENCES users(id)
        )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_userId ON accounts(userId)`);
};

const prepareStatements = () => {
    stmts = {
        getUser: db.prepare(`SELECT * FROM users WHERE id = ?`),
        getAccounts: db.prepare(`SELECT * FROM accounts WHERE userId = ? ORDER BY createdAt ASC`),
        upsertUser: db.prepare(`INSERT OR REPLACE INTO users (id, currentAccount, settings, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`),
        upsertAccount: db.prepare(`INSERT OR REPLACE INTO accounts (puuid, userId, username, region, auth, alerts, authFailures, lastFetchedData, lastNoticeSeen, lastSawEasterEgg, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        deleteUserAccounts: db.prepare(`DELETE FROM accounts WHERE userId = ?`),
        deleteUser: db.prepare(`DELETE FROM users WHERE id = ?`),
        getAccountByPuuid: db.prepare(`SELECT * FROM accounts WHERE puuid = ?`),
        getAllUserIds: db.prepare(`SELECT id FROM users`),
        deleteAccount: db.prepare(`DELETE FROM accounts WHERE puuid = ?`),
        updateSingleAccount: db.prepare(`UPDATE accounts SET username = ?, region = ?, auth = ?, alerts = ?, authFailures = ?, lastFetchedData = ?, lastNoticeSeen = ?, lastSawEasterEgg = ?, updatedAt = ? WHERE puuid = ?`),
        getUserIdsWithAlertsOrDailyShop: db.prepare(`SELECT DISTINCT u.id FROM users u LEFT JOIN accounts a ON a.userId = u.id WHERE (a.alerts IS NOT NULL AND a.alerts != '[]') OR (u.settings LIKE '%"dailyShop"%')`),
    };
};

/**
 * @param {string} id
 * @returns {UserData|null}
 */
export const getUserFromDb = (id) => {
    if (!id) return null;
    if (batchMode && batchQueue.has(id)) {
        return batchQueue.get(id);
    }
    if (!db || !stmts?.getUser) return null;
    const userRow = stmts.getUser.get(id);
    if (!userRow) return null;

    const accountRows = stmts.getAccounts ? stmts.getAccounts.all(id) : [];

    return {
        id: userRow.id,
        accounts: accountRows.map(row => ({
            id: userRow.id,
            puuid: row.puuid,
            username: row.username,
            region: row.region,
            auth: safeJsonParse(row.auth, {}, "account.auth"),
            alerts: removeDupeAlerts(row.alerts ? safeJsonParse(row.alerts, [], "account.alerts") : []),
            authFailures: row.authFailures,
            lastFetchedData: row.lastFetchedData,
            lastNoticeSeen: row.lastNoticeSeen,
            lastSawEasterEgg: row.lastSawEasterEgg
        })),
        currentAccount: userRow.currentAccount,
        settings: safeJsonParse(userRow.settings, {}, "user.settings")
    };
};

const saveUserToDbTransaction = (user) => {
    const now = Date.now();

    stmts.upsertUser.run(
        user.id,
        user.currentAccount || 1,
        JSON.stringify(user.settings || {}),
        user.createdAt || now,
        now
    );

    for (const account of user.accounts || []) {
        stmts.upsertAccount.run(
            account.puuid,
            user.id,
            account.username || "",
            account.region || null,
            JSON.stringify(account.auth || {}),
            JSON.stringify(account.alerts || []),
            account.authFailures || 0,
            account.lastFetchedData || null,
            account.lastNoticeSeen || null,
            account.lastSawEasterEgg || 0,
            account.createdAt || now,
            now
        );
    }
};

export const saveUserToDb = (user) => {
    if (batchMode) {
        batchQueue.set(user.id, user);
        return;
    }
    if (db.inTransaction) {
        saveUserToDbTransaction(user);
    } else {
        saveUserToDbInTransaction(user);
    }
};

export const beginBatchWrites = () => {
    batchMode = true;
    batchQueue.clear();
    batchAccountQueue.clear();
};

export const commitBatchWrites = () => {
    if (!batchMode) return;
    batchMode = false;

    if (batchQueue.size === 0 && batchAccountQueue.size === 0) {
        batchQueue.clear();
        batchAccountQueue.clear();
        return;
    }

    const users = Array.from(batchQueue.values());
    const accounts = Array.from(batchAccountQueue.values());
    batchQueue.clear();
    batchAccountQueue.clear();

    const batchTransaction = db.transaction(() => {
        for (const user of users) {
            saveUserToDbTransaction(user);
        }
        for (const account of accounts) {
            stmts.updateSingleAccount.run(
                account.username || "",
                account.region || null,
                JSON.stringify(account.auth || {}),
                JSON.stringify(account.alerts || []),
                account.authFailures || 0,
                account.lastFetchedData || null,
                account.lastNoticeSeen || null,
                account.lastSawEasterEgg || 0,
                Date.now(),
                account.puuid
            );
        }
    });
    batchTransaction();
};

export const deleteUserFromDb = (id) => {
    const transaction = db.transaction(() => {
        stmts.deleteUserAccounts.run(id);
        stmts.deleteUser.run(id);
    });
    transaction();
};

export const getAccountByPuuid = (puuid) => {
    const row = stmts.getAccountByPuuid.get(puuid);
    if (!row) return null;

    return {
        id: row.userId,
        puuid: row.puuid,
        username: row.username,
        region: row.region,
        auth: safeJsonParse(row.auth, {}, "account.auth"),
        alerts: row.alerts ? safeJsonParse(row.alerts, [], "account.alerts") : [],
        authFailures: row.authFailures,
        lastFetchedData: row.lastFetchedData,
        lastNoticeSeen: row.lastNoticeSeen,
        lastSawEasterEgg: row.lastSawEasterEgg
    };
};

export const getAllUserIds = () => {
    return stmts.getAllUserIds.all().map(row => row.id);
};

export const getUserIdsWithAlertsOrDailyShop = () => {
    return stmts.getUserIdsWithAlertsOrDailyShop.all().map(row => row.id);
};

export const deleteAccountFromDb = (puuid) => {
    stmts.deleteAccount.run(puuid);
};

export const updateSingleAccountInDb = (account) => {
    if (batchMode) {
        batchAccountQueue.set(account.puuid, account);
        return true;
    }
    const result = stmts.updateSingleAccount.run(
        account.username || "",
        account.region || null,
        JSON.stringify(account.auth || {}),
        JSON.stringify(account.alerts || []),
        account.authFailures || 0,
        account.lastFetchedData || null,
        account.lastNoticeSeen || null,
        account.lastSawEasterEgg || 0,
        Date.now(),
        account.puuid
    );
    return result.changes > 0;
};

export const runUserDbTransaction = (fn) => {
    const transaction = db.transaction(fn);
    return transaction();
};

export const closeUserDatabase = () => {
    if (db) {
        db.close();
        db = null;
        stmts = {};
    }
};
