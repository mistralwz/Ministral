import fs from "fs";
import { removeDupeAlerts } from "../misc/util.js";
import { defaultSettings, clearSettingsCache } from "../misc/settings.js";
import { dedupeUserAccountsByPuuid, getUserFromDb, saveUserToDb, deleteUserFromDb, deleteAccountFromDb, runUserDbTransaction, updateSingleAccountInDb } from "../misc/userDatabase.js";

export const readUserJson = (id) => {
    const userJson = getUserFromDb(id);
    if (userJson && dedupeUserAccountsByPuuid(userJson)) {
        saveUserToDb(userJson);
    }
    return userJson;
}

export const getUserJson = (id, account = null) => {
    const user = readUserJson(id);
    if (!user) return null;

    account = account || user.currentAccount || 1;
    if (account > user.accounts.length) account = 1;

    return user.accounts[account - 1];
}

export const saveUserJson = (id, json) => {
    if (!json.id) json.id = id;
    saveUserToDb(json);
}

export const saveUser = (user, account = null) => {
    // Fast path: if the account already exists in DB, update just that one row
    if (user.puuid && updateSingleAccountInDb(user)) {
        return;
    }
    // Slow path: full read-modify-write (new user or account not yet in DB)
    runUserDbTransaction(() => {
        const userJson = getUserFromDb(user.id);
        if (!userJson) {
            saveUserToDb({
                id: user.id,
                accounts: [user],
                currentAccount: 1,
                settings: defaultSettings
            });
            return;
        }

        if (!account) account = userJson.accounts.findIndex(a => a.puuid === user.puuid) + 1 || userJson.currentAccount;
        if (account > userJson.accounts.length) account = userJson.accounts.length;

        userJson.accounts[(account || userJson.currentAccount) - 1] = user;
        saveUserToDb(userJson);
    });
}

export const addUser = (user) => {
    console.log(`[addUser] Saving user ${user.id} to database`);
    runUserDbTransaction(() => {
        const userJson = getUserFromDb(user.id);
        if (userJson) {
            // Check for duplicate accounts
            let foundDuplicate = false;
            for (let i = 0; i < userJson.accounts.length; i++) {
                if (userJson.accounts[i].puuid === user.puuid) {
                    const oldUser = userJson.accounts[i];

                    // Merge the accounts
                    userJson.accounts[i] = user;
                    userJson.currentAccount = i + 1;

                    // Copy over data from old account
                    user.alerts = removeDupeAlerts(oldUser.alerts.concat(userJson.accounts[i].alerts));
                    user.lastFetchedData = oldUser.lastFetchedData;
                    user.lastNoticeSeen = oldUser.lastNoticeSeen;
                    user.lastSawEasterEgg = oldUser.lastSawEasterEgg;

                    foundDuplicate = true;
                    break;
                }
            }

            if (!foundDuplicate) {
                userJson.accounts.push(user);
                userJson.currentAccount = userJson.accounts.length;
            }

            saveUserToDb(userJson);
        } else {
            saveUserToDb({
                id: user.id,
                accounts: [user],
                currentAccount: 1,
                settings: defaultSettings
            });
        }
    });
}

export const deleteUser = (id, accountNumber) => {
    return runUserDbTransaction(() => {
        const userJson = getUserFromDb(id);
        if (!userJson) return null;

        const indexToDelete = (accountNumber || userJson.currentAccount) - 1;
        const userToDelete = userJson.accounts[indexToDelete];
        if (!userToDelete) return null;

        userJson.accounts.splice(indexToDelete, 1);
        if (userJson.accounts.length === 0) {
            deleteUserFromDb(id);
            clearSettingsCache(id);
        } else {
            if (userJson.currentAccount > userJson.accounts.length) {
                userJson.currentAccount = userJson.accounts.length;
            }
            deleteAccountFromDb(userToDelete.puuid);
            saveUserToDb(userJson);
            clearSettingsCache(id);
        }

        return userToDelete.username;
    });
}

export const deleteWholeUser = async (id) => {
    const userJson = readUserJson(id);
    if (userJson) {
        const { deleteShopData } = await import("../misc/redisQueue.js");
        for (const puuid of userJson.accounts.map(a => a.puuid)) {
            try { await deleteShopData(puuid); } catch (e) { }
        }
    }
    deleteUserFromDb(id);
    clearSettingsCache(id);
}

export const getNumberOfAccounts = (id) => {
    const user = readUserJson(id);
    if (!user) return 0;
    return user.accounts.length;
}

export const switchAccount = (id, accountNumber) => {
    const userJson = readUserJson(id);
    if (!userJson) return;

    userJson.currentAccount = accountNumber;
    saveUserToDb(userJson);

    return userJson.accounts[accountNumber - 1];
}

export const getAccountWithPuuid = (id, puuid) => {
    const userJson = readUserJson(id);
    if (!userJson) return null;
    return userJson.accounts.find(a => a.puuid === puuid);
}

export const findTargetAccountIndex = (id, query) => {
    const userJson = readUserJson(id);
    if (!userJson) return null;

    let index = userJson.accounts.findIndex(a => a.username === query || a.puuid === query);
    if (index !== -1) return index + 1;

    return parseInt(query) || null;
}


