import Database from "better-sqlite3";
import { localLog, localError } from "./logger.js";
import path from "path";

let db = null;

// Pre-prepared statements (initialized once, reused for all queries)
let stmts = {};
let saveUserToDbInTransaction = null;

// Batch write state: accumulate user saves and flush in one transaction
let batchMode = false;
let batchQueue = new Map(); // userId -> user (last write wins per user)

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
        db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
        db.pragma('foreign_keys = ON');

        // Create tables if they don't exist
        createTables();
        // Prepare all statements once
        prepareStatements();
        // Precompile reusable write transaction (avoids allocating a new wrapper on each save)
        saveUserToDbInTransaction = db.transaction(saveUserToDbTransaction);
        localLog(`User database initialized at ${dbPath}`);
        return true;
    } catch (e) {
        localError("Failed to initialize user database:", e);
        return false;
    }
};

const createTables = () => {
    // Users table (one per Discord user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            currentAccount INTEGER NOT NULL DEFAULT 1,
            settings TEXT NOT NULL,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
        )
    `);

    // Accounts table (multiple per user)
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

    // Create index for faster lookups
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
        updateAccountAuth: db.prepare(`UPDATE accounts SET auth = ?, updatedAt = ? WHERE puuid = ?`),
        countUsers: db.prepare(`SELECT COUNT(*) as count FROM users`),
        getAccountsByUserId: db.prepare(`SELECT * FROM accounts WHERE userId = ?`),
        // Targeted single-account update (avoids rewriting all accounts)
        updateSingleAccount: db.prepare(`UPDATE accounts SET username = ?, region = ?, auth = ?, alerts = ?, authFailures = ?, lastFetchedData = ?, lastNoticeSeen = ?, lastSawEasterEgg = ?, updatedAt = ? WHERE puuid = ?`),
        // Only users that have at least one account with alerts, or a dailyShop setting
        getUserIdsWithAlertsOrDailyShop: db.prepare(`SELECT DISTINCT u.id FROM users u LEFT JOIN accounts a ON a.userId = u.id WHERE (a.alerts IS NOT NULL AND a.alerts != '[]') OR (u.settings LIKE '%"dailyShop"%')`),

    };
};

// ==================== USER OPERATIONS ====================

export const getUserFromDb = (id) => {
    const userRow = stmts.getUser.get(id);
    if (!userRow) return null;

    // Get all accounts for this user
    const accountRows = stmts.getAccounts.all(id);

    // Reconstruct the user object
    return {
        id: userRow.id,
        accounts: accountRows.map(row => ({
            id: userRow.id,
            puuid: row.puuid,
            username: row.username,
            region: row.region,
            auth: safeJsonParse(row.auth, {}, "account.auth"),
            alerts: row.alerts ? safeJsonParse(row.alerts, [], "account.alerts") : [],
            authFailures: row.authFailures,
            lastFetchedData: row.lastFetchedData,
            lastNoticeSeen: row.lastNoticeSeen,
            lastSawEasterEgg: row.lastSawEasterEgg
        })),
        currentAccount: userRow.currentAccount,
        settings: safeJsonParse(userRow.settings, {}, "user.settings")
    };
};

// Wrap saveUserToDb in an explicit transaction so all account upserts share a single fsync
const saveUserToDbTransaction = (user) => {
    const now = Date.now();

    // Save/update user
    stmts.upsertUser.run(
        user.id,
        user.currentAccount || 1,
        JSON.stringify(user.settings || {}),
        user.createdAt || now,
        now
    );

    // Save/update each account
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
        // Buffer the write; last mutation wins if the same user is saved twice
        batchQueue.set(user.id, user);
        return;
    }
    // If already inside a transaction (e.g. runUserDbTransaction), just run directly.
    // Otherwise wrap in a transaction so multiple account upserts share one fsync.
    if (db.inTransaction) {
        saveUserToDbTransaction(user);
    } else {
        saveUserToDbInTransaction(user);
    }
};

/**
 * Begin accumulating saveUserToDb calls into a buffer.
 * Call commitBatchWrites() to flush them all in a single transaction.
 */
export const beginBatchWrites = () => {
    batchMode = true;
    batchQueue.clear();
};

/**
 * Flush all buffered user saves in a single SQLite transaction, then exit batch mode.
 * Safe to call even if beginBatchWrites was not called (no-op).
 */
export const commitBatchWrites = () => {
    if (!batchMode) return;
    batchMode = false;

    if (batchQueue.size === 0) {
        batchQueue.clear();
        return;
    }

    const users = Array.from(batchQueue.values());
    batchQueue.clear();

    const batchTransaction = db.transaction(() => {
        for (const user of users) {
            saveUserToDbTransaction(user);
        }
    });
    batchTransaction();
};

export const deleteUserFromDb = (id) => {
    // Also delete associated accounts
    stmts.deleteUserAccounts.run(id);
    stmts.deleteUser.run(id);
};

// ==================== ACCOUNT OPERATIONS ====================

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

/**
 * Returns only user IDs that have at least one account with non-empty alerts,
 * or a dailyShop setting configured. Skips completely inactive users.
 */
export const getUserIdsWithAlertsOrDailyShop = () => {
    return stmts.getUserIdsWithAlertsOrDailyShop.all().map(row => row.id);
};

export const deleteAccountFromDb = (puuid) => {
    stmts.deleteAccount.run(puuid);
};

/**
 * Update a single account in the DB without reading/rewriting the entire user.
 * The account must already exist (identified by puuid).
 * Returns true if the row was updated, false if puuid was not found.
 */
export const updateSingleAccountInDb = (account) => {
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

export const updateAccountAuthFromDb = (puuid, auth) => {
    stmts.updateAccountAuth.run(JSON.stringify(auth), Date.now(), puuid);
};

// ==================== QUERY OPERATIONS ====================

export const countAllUsers = () => {
    return stmts.countUsers.get().count;
};

export const getUsersByUserId = (userId) => {
    const rows = stmts.getAccountsByUserId.all(userId);
    
    return rows.map(row => ({
        puuid: row.puuid,
        username: row.username,
        region: row.region,
        auth: safeJsonParse(row.auth, {}, "account.auth"),
        alerts: row.alerts ? safeJsonParse(row.alerts, [], "account.alerts") : [],
        authFailures: row.authFailures,
        lastFetchedData: row.lastFetchedData,
        lastNoticeSeen: row.lastNoticeSeen,
        lastSawEasterEgg: row.lastSawEasterEgg
    }));
};

// ==================== TRANSACTION HELPERS ====================

export const transactionUpdateUser = (userId, updateFn) => {
    const transaction = db.transaction(() => {
        const user = getUserFromDb(userId);
        if (!user) return null;

        const updated = updateFn(user);
        if (updated) {
            saveUserToDb(updated);
        }
        return updated;
    });

    return transaction();
};

export const runUserDbTransaction = (fn) => {
    const transaction = db.transaction(fn);
    return transaction();
};

// ==================== MAINTENANCE ====================

export const closeUserDatabase = () => {
    if (db) {
        db.close();
        db = null;
    }
};

export const backupUserDatabase = (backupPath = "data/users.db.backup") => {
    if (!db) return false;

    try {
        const backup = new Database(backupPath);
        db.backup(backup);
        backup.close();
        localLog(`User database backed up to ${backupPath}`);
        return true;
    } catch (e) {
        localError("Failed to backup user database:", e);
        return false;
    }
};

export const isUserDatabaseReady = () => {
    return db !== null;
};
