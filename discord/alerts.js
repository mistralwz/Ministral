import {
    discordTag,
    fetchChannel,
    getChannelGuildId,
    removeAlertActionRow,
    removeDupeAlerts,
    skinNameAndEmoji,
    wait,
    removeAlertButton
} from "../misc/util.js";
import {authUser, deleteUserAuth, getUser, getUserList, getAlertUserList, beginUserCacheScope, endUserCacheScope, invalidateUserCache} from "../valorant/auth.js";
import {getOffers} from "../valorant/shop.js";
import {getSkin} from "../valorant/cache.js";
import {alertsPageEmbed, authFailureMessage, basicEmbed, renderOffers, VAL_COLOR_1, skinEmbed} from "./embed.js";
import {client} from "./bot.js";
import config from "../misc/config.js";
import {l, s} from "../misc/languages.js";
import {readUserJson, saveUser} from "../valorant/accountSwitcher.js";
import {beginBatchWrites, commitBatchWrites} from "../misc/userDatabase.js";
import {sendShardMessage, sendShardMessageForChannel} from "../misc/shardMessage.js";
import {VPEmoji} from "./emoji.js";
import {getSetting} from "../misc/settings.js";
import { ActionRowBuilder } from "discord.js";

/* Alert format: {
 *     uuid: skin uuid
 *     channel_id: discord text channel id the alert was sent in
 * }
 * Each user should have one alert per skin.
 */

// Channel validation cache: Map<channelId, {canAccess: boolean, timestamp: number}>
// Short TTL so stale cross-shard entries (e.g. bot kicked from a guild) expire quickly.
const channelAccessCache = new Map();
const CACHE_DURATION = 60 * 1000; // 1 minute

export const canAccessChannel = async (channelId) => {
    // Check cache first
    const cached = channelAccessCache.get(channelId);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.canAccess;
    }

    // Perform the check (same logic as testAlerts)
    try {
        const channel = await fetchChannel(channelId);
        if (!channel) {
            channelAccessCache.set(channelId, {canAccess: false, timestamp: Date.now()});
            return false;
        }

        // Try to send a test message (we won't actually send it, just check permissions)
        if (channel.guild) {
            const permissions = channel.permissionsFor(client.user);
            if (!permissions || !permissions.has('ViewChannel') || !permissions.has('SendMessages')) {
                channelAccessCache.set(channelId, {canAccess: false, timestamp: Date.now()});
                return false;
            }
        }

        channelAccessCache.set(channelId, {canAccess: true, timestamp: Date.now()});
        return true;
    } catch (e) {
        console.error(`Channel access check failed for ${channelId}:`, e.message);
        channelAccessCache.set(channelId, {canAccess: false, timestamp: Date.now()});
        return false;
    }
}

export const clearChannelAccessCache = (channelId = null) => {
    if (channelId) {
        channelAccessCache.delete(channelId);
    } else {
        channelAccessCache.clear();
    }
}

export const addAlert = (id, alert) => {
    const user = getUser(id);
    if(!user) return;

    user.alerts.push(alert);
    saveUser(user);
}

export const alertsForUser = (id, account=null) => {
    if(account === -1) { // -1 to get all alerts for user across accounts
        const user = readUserJson(id);
        if(!user) return [];

        return user.accounts.map(account => account.alerts).flat();
    }

    const user = getUser(id, account);
    if(user) return user.alerts;
    return [];
}

export const alertExists = (id, uuid) => {
    return alertsForUser(id).find(alert => alert.uuid === uuid) || false;
}

export const filteredAlertsForUser = async (interaction) => {
    let alerts = alertsForUser(interaction.user.id);

    // bring the alerts in this channel to the top
    const alertPriority = (alert) => {
        if(alert.channel_id === interaction.channelId) return 2;
        const channel = client.channels.cache.get(alert.channel_id)
        if(interaction.guild && channel && channel.client.channels.cache.get(alert.channel_id).guildId === interaction.guild.id) return 1;
        return 0;
    }
    alerts.sort((alert1, alert2) => alertPriority(alert2) - alertPriority(alert1));

    return alerts;
}

export const alertsPerChannelPerGuild = async () => {
    const guilds = {};
    for(const id of getUserList()) {
        const alerts = alertsForUser(id, -1);
        for(const alert of alerts) {
            const guildId = await getChannelGuildId(alert.channel_id);

            if(!(guildId in guilds)) guilds[guildId] = {};
            if(!(alert.channel_id in guilds[guildId])) guilds[guildId][alert.channel_id] = 1;
            else guilds[guildId][alert.channel_id]++;
        }
    }
    return guilds;
}

export const removeAlert = (id, uuid) => {
    const user = getUser(id);
    const alertCount = user.alerts.length;
    user.alerts = user.alerts.filter(alert => alert.uuid !== uuid);
    saveUser(user);
    return alertCount > user.alerts.length;
}

const ALERT_BATCH_SIZE = 50;

/**
 * Process alerts for a single user across all their Valorant accounts.
 * Extracted so it can be called from both sequential and concurrent paths.
 *
 * @param {string}  id               Discord user ID
 * @param {boolean} initialShouldWait If true, delay before the first real network fetch
 * @returns {boolean} shouldWait state after this user (pass to the next user in sequential mode)
 */
const processUserAlerts = async (id, initialShouldWait = false) => {
    let shouldWait = initialShouldWait;
    let credsExpiredAlerts = false;

    const userJson = readUserJson(id);
    if(!userJson) return shouldWait;

    const accountCount = userJson.accounts.length;
    for(let i = 1; i <= accountCount; i++) {

        const rawUserAlerts = alertsForUser(id, i);
        const dailyShopChannel = getSetting(id, "dailyShop");
        if(!rawUserAlerts?.length && !dailyShopChannel) continue;
        if(!rawUserAlerts?.length && dailyShopChannel && i !== userJson.currentAccount) continue;

        if(shouldWait) {
            await wait(config.delayBetweenAlerts); // to prevent being ratelimited
            shouldWait = false;
        }

        const valorantUser = getUser(id, i);
        const discordUser = client.users.cache.get(id);
        const discordUsername = discordUser ? discordUser.username : id;
        console.log(`Checking user ${discordUsername}'s ${valorantUser.username} account (${i}/${accountCount}) for alerts...`);

        const userAlerts = removeDupeAlerts(rawUserAlerts);
        if(userAlerts.length !== rawUserAlerts.length) {
            valorantUser.alerts = userAlerts;
            saveUser(valorantUser, i);
            invalidateUserCache(id);
        }

        let offers;
        do { // retry loop in case of rate limit or maintenance
            offers = await getOffers(id, i);
            shouldWait = valorantUser.auth && !offers.cached;

            if(!offers.success) {
                if(offers.maintenance) {
                    console.log("Valorant servers are under maintenance, waiting 15min before continuing alert checks...");
                    await wait(15 * 60 * 1000);
                }

                else if(offers.rateLimit) {
                    const waitMs = offers.rateLimit - Date.now();
                    console.error(`I got ratelimited while checking alerts for user ${id} #${i} for ${Math.floor(waitMs / 1000)}s!`);
                    await wait(waitMs);
                }

                else {
                    if(!credsExpiredAlerts) {
                        if(valorantUser.authFailures < config.authFailureStrikes) {
                            valorantUser.authFailures++;
                            credsExpiredAlerts = userAlerts;
                        }
                    }

                    deleteUserAuth(valorantUser);
                    invalidateUserCache(id);
                    break;
                }
            }

        } while(!offers.success);

        if(offers.success && offers.offers) {
            if(dailyShopChannel && i === userJson.currentAccount) await sendDailyShop(id, offers, dailyShopChannel, valorantUser);

            const positiveAlerts = userAlerts.filter(alert => offers.offers.includes(alert.uuid));
            if(positiveAlerts.length) await sendAlert(id, i, positiveAlerts, offers.expires);
        }
    }

    if(credsExpiredAlerts) {
        // user login is invalid
        const channelsSent = [];
        for(const alert of credsExpiredAlerts) {
            if(!channelsSent.includes(alert.channel_id)) {
                await sendCredentialsExpired(id, alert);
                channelsSent.push(alert.channel_id);
            }
        }
    }

    return shouldWait;
}

export const checkAlerts = async () => {
    // C2: Each shard processes its own partition of users (by Discord snowflake modulo).
    // The cron fires on all shards simultaneously — no broadcast needed.
    const myShardId = client.shard?.ids[0] ?? 0;
    const totalShards = client.shard?.count ?? 1;

    console.log(`[Shard ${myShardId}] Checking new shop skins for alerts...`);

    try {
        const allUsers = getAlertUserList();

        // Partition: each shard handles the users whose snowflake maps to it.
        // Users with no shard (non-sharded run) are handled by the single instance.
        const userList = totalShards > 1
            ? allUsers.filter(id => Number(BigInt(id) >> 22n) % totalShards === myShardId)
            : allUsers;

        if(userList.length === 0) {
            console.log(`[Shard ${myShardId}] No users in this shard's partition, skipping.`);
            return;
        }

        const concurrency = config.alertConcurrency ?? 1;

        if(concurrency > 1) {
            // A5: Concurrent mode — process up to `alertConcurrency` users in parallel.
            // Set alertConcurrency > 1 in config.json to enable. Default is 1 (sequential).
            const { default: pLimit } = await import("p-limit");
            const limit = pLimit(concurrency);

            // Single global batch wraps the entire concurrent run
            beginBatchWrites();
            try {
                await Promise.all(userList.map(id => limit(async () => {
                    try {
                        beginUserCacheScope();
                        // Each concurrent task starts fresh — no inter-user delay needed
                        await processUserAlerts(id);
                    } catch(e) {
                        console.error("There was an error while trying to fetch and send alerts for user " + discordTag(id));
                        console.error(e);
                    } finally {
                        endUserCacheScope();
                    }
                })));
            } finally {
                commitBatchWrites();
            }
        } else {
            // Sequential mode (default): process users one at a time in batches of ALERT_BATCH_SIZE.
            // Each batch is flushed as a single SQLite transaction, reducing write contention (A1).
            let shouldWait = false;
            let batchStart = 0;
            while(batchStart < userList.length) {
                const batchEnd = Math.min(batchStart + ALERT_BATCH_SIZE, userList.length);
                beginBatchWrites();
                try {
                    for(let j = batchStart; j < batchEnd; j++) {
                        const id = userList[j];
                        try {
                            beginUserCacheScope();
                            shouldWait = await processUserAlerts(id, shouldWait);
                        } catch(e) {
                            console.error("There was an error while trying to fetch and send alerts for user " + discordTag(id));
                            console.error(e);
                        } finally {
                            endUserCacheScope();
                        }
                    }
                } finally {
                    commitBatchWrites(); // flush this batch in one SQLite transaction
                }
                batchStart = batchEnd;
            }
        }

        console.log(`[Shard ${myShardId}] Finished checking alerts!`);
    } catch(e) {
        // should I send messages in the discord channels?
        console.error("There was an error while trying to send alerts!");
        console.error(e);
    }
}

export const sendAlert = async (id, account, alerts, expires, tryOnOtherShard=true, alertsLength=alerts.length) => {
    const user = client.users.cache.get(id);
    const username = user ? user.username : id;

    let filteredAlerts = {};
    /* filteredAlerts looks like this:
    {
        "channelId1": [{uuid: "skinUUID", channel_id: "channelId1"}, {uuid: "skinUUID2", channel_id: "channelId1"}],
        "channelId2": [{uuid: "skinUUID3", channel_id: "channelId2"}],
        "channelId3": [{uuid: "skinUUID5", channel_id: "channelId3"}]
    }
    */
    const valorantUser = getUser(id, account);
    if(!valorantUser) return;

    if(tryOnOtherShard)
    for(const alert of alerts) {
        if(!filteredAlerts[alert.channel_id]) filteredAlerts[alert.channel_id] = [alert];
        else filteredAlerts[alert.channel_id].push(alert);
    }
    else filteredAlerts[alerts[0].channel_id] = alerts

    for(const channel_id of Object.keys(filteredAlerts)) {

        const message = {
            content:  `<@${id}>`,
            embeds: [],
            components: []
        };
        const buttons = [];
        const alertsArray = filteredAlerts[channel_id];

        const channel = await fetchChannel(channel_id);
        if(!channel) {
            if(client.shard && tryOnOtherShard) {
                const delivered = await sendShardMessageForChannel({
                    type: "alert",
                    alerts: filteredAlerts[channel_id],
                    id, account, expires, alertsLength
                }, channel_id);
                if(!delivered) {
                    // No shard has this channel - it's truly inaccessible
                    console.error(`Cannot access alert channel ${channel_id} for user ${username} on any shard, attempting to migrate to DM...`);
                    await notifyChannelInaccessible(id, channel_id, 'alert');
                }
            } else if(!client.shard) {
                // Not sharded and channel not found - truly inaccessible
                console.error(`Cannot access alert channel ${channel_id} for user ${username}, attempting to migrate to DM...`);
                await notifyChannelInaccessible(id, channel_id, 'alert');
            }
            // If tryOnOtherShard=false and channel not found, silently skip -
            // the originating shard handles the fallback via sendShardMessageForChannel
            continue;
        }

        console.log(`Sending alert for user ${username}...`);

        if(alertsArray.length === alertsLength && alertsLength > 1)
            message.embeds.push({
                description: s(valorantUser).info.MULTIPLE_ALERT_HAPPENED.f({i: id, u: valorantUser.username, t: expires}, id),
                color: VAL_COLOR_1
            });
            else if(alertsArray.length < alertsLength)
            message.embeds.push({
                description: s(valorantUser).info.MULTIPLE_ALERT_HAPPENED_ON_DIFF_CHANNEL.f({i: id, u: valorantUser.username, t: expires, cid: client.application.commands.cache.find(c => c.name === "alerts").id}, id),
                color: VAL_COLOR_1
            });
        for(const alert of alertsArray) {
            const skin = await getSkin(alert.uuid);
            console.log(`User ${valorantUser.username} has the skin ${l(skin.names)} in their shop!`); //only we see it, no need to see the skin name in another language
            if(alertsLength === 1){
                message.embeds.push({
                    description: s(valorantUser).info.ALERT_HAPPENED.f({i: id, u: valorantUser.username, s: await skinNameAndEmoji(skin, channel, valorantUser), t: expires}, id),
                    color: VAL_COLOR_1,
                    thumbnail: {
                        url: skin.icon
                    }
                });
                buttons.push(removeAlertButton(id, alert.uuid, s(valorantUser).info.REMOVE_ALERT_BUTTON))
            } else {
                message.embeds.push(await skinEmbed(skin, skin.price, id, await VPEmoji(id, channel), channel))
                let skinName = l(skin.names, id)
                if (skinName.length > 80) skinName = skinName.slice(0, 76) + " ...";
                buttons.push(removeAlertButton(id, alert.uuid, skinName))
            }
        }
        message.components.push(new ActionRowBuilder().addComponents(buttons.map(i=>i)))
        await channel.send(message).catch(async e => {
            console.error(`Could not send alert message in #${channel.name}! Do I have the right role?`);

            try { // try to log the alert to the console
                const user = await client.users.fetch(id).catch(() => {});
                if(user) console.error(`Please tell ${user.tag} that the skin his want is in their item shop!`); // sorry for that :(
            } catch(e) {}

            console.error(e);
        });
    }
}

export const sendCredentialsExpired = async (id, alert, tryOnOtherShard=true) => {
    const channel = await fetchChannel(alert.channel_id);
    if(!channel) {
        if(client.shard && tryOnOtherShard) {
            const delivered = await sendShardMessageForChannel({
                type: "credentialsExpired",
                id, alert
            }, alert.channel_id);
            if(!delivered) {
                const user = await client.users.fetch(id).catch(() => {});
                if(user) console.error(`Please tell ${user.tag} that their credentials have expired, and that they should /login again. (I can't find the channel where the alert was set up on any shard)`);
            }
            return;
        }

        if(!client.shard) {
            const user = await client.users.fetch(id).catch(() => {});
            if(user) console.error(`Please tell ${user.tag} that their credentials have expired, and that they should /login again. (I can't find the channel where the alert was set up)`);
        }
        // If tryOnOtherShard=false and channel not found, silently skip
        return;
    }

    if(channel.guild) {
        const memberInGuild = await channel.guild.members.fetch(id).catch(() => {});
        if(!memberInGuild) return; // the user is no longer in that guild
    }

    const valorantUser = getUser(id);
    if(!valorantUser) return;

    await channel.send({
        content: `<@${id}>`,
        embeds: [{
            description: s(valorantUser).error.AUTH_ERROR_ALERTS_HAPPENED.f({u: id}),
            color: VAL_COLOR_1,
        }]
    }).catch(async e => {
        console.error(`Could not send message in #${channel.name}! Do I have the right role?`);

        try { // try to log the alert to the console
            const user = await client.users.fetch(id).catch(() => {});
            if(user) console.error(`Please tell ${user.tag} that their credentials have expired, and that they should /login again. Also tell them that they should fix their perms.`);
        } catch(e) {}

        console.error(e);
    });
}

export const sendDailyShop = async (id, shop, channelId, valorantUser, tryOnOtherShard=true) => {
    const channel = await fetchChannel(channelId);
    if(!channel) {
        if(client.shard && tryOnOtherShard) {
            const delivered = await sendShardMessageForChannel({
                type: "dailyShop",
                id, shop, channelId, valorantUser
            }, channelId);
            if(!delivered) {
                const user = await client.users.fetch(id).catch(() => {});
                if(user) {
                    console.error(`Cannot access daily shop channel ${channelId} for user ${user.tag} on any shard, attempting to notify via DM...`);
                    await notifyChannelInaccessible(id, channelId, 'dailyShop');
                }
            }
            return;
        }

        if(!client.shard) {
            const user = await client.users.fetch(id).catch(() => {});
            if(user) {
                console.error(`Cannot access daily shop channel ${channelId} for user ${user.tag}, attempting to notify via DM...`);
                await notifyChannelInaccessible(id, channelId, 'dailyShop');
            }
        }
        // If tryOnOtherShard=false and channel not found, silently skip
        return;
    }

    const shouldPing = getSetting(id, "pingOnAutoDailyShop");
    const content = shouldPing ? `<@${id}>` : null;

    const rendered = await renderOffers(shop, id, valorantUser, await VPEmoji(id, channel));
    await channel.send({
        content,
        ...rendered
    });
}

export const migrateAlertsToUserDM = async (id, channelId) => {
    const userJson = readUserJson(id);
    if (!userJson) return 0;

    let migratedCount = 0;
    const user = await client.users.fetch(id).catch(() => null);
    const userDMChannelId = user?.dmChannel?.id || (await user?.createDM().catch(() => null))?.id;

    if (!userDMChannelId) {
        console.error(`Cannot migrate alerts for user ${id} - unable to create DM channel`);
        return 0;
    }

    for (let i = 0; i < userJson.accounts.length; i++) {
        const account = userJson.accounts[i];
        if (!account.alerts) continue;

        const alertsToMigrate = account.alerts.filter(alert => alert.channel_id === channelId);
        if (alertsToMigrate.length === 0) continue;

        // Update channel_id for migrated alerts
        account.alerts = account.alerts.map(alert => {
            if (alert.channel_id === channelId) {
                console.log(`Migrating alert for skin ${alert.uuid} from channel ${channelId} to DM for user ${id}`);
                migratedCount++;
                return { ...alert, channel_id: userDMChannelId };
            }
            return alert;
        });
    }

    if (migratedCount > 0) {
        const {saveUserJson} = await import("../valorant/accountSwitcher.js");
        saveUserJson(id, userJson);
        console.log(`Migrated ${migratedCount} alert(s) to DM for user ${id}`);
    }

    return migratedCount;
}

export const notifyChannelInaccessible = async (id, channelId, type = 'alert') => {
    try {
        const user = await client.users.fetch(id).catch(() => null);
        if (!user) {
            console.error(`Cannot notify user ${id} - user not found`);
            return false;
        }

        const valorantUser = getUser(id);
        if (!valorantUser) {
            console.error(`Cannot notify user ${id} - valorant user not found`);
            return false;
        }

        const reason = await diagnoseChannelIssue(channelId, id);
        const perms = s(valorantUser).error.ALERT_NO_PERMS;
        
        let message = '';
        if (type === 'dailyShop') {
            message = s(valorantUser).error.DAILY_SHOP_CHANNEL_INACCESSIBLE.f({
                perms,
                c: channelId,
                r: reason
            });
        } else {
            const migratedCount = await migrateAlertsToUserDM(id, channelId);
            
            if (migratedCount > 0) {
                message = s(valorantUser).error.ALERT_CHANNEL_INACCESSIBLE_MIGRATED.f({
                    perms,
                    c: channelId,
                    r: reason,
                    n: migratedCount
                });
            } else {
                message = s(valorantUser).error.ALERT_CHANNEL_INACCESSIBLE.f({
                    perms,
                    c: channelId,
                    r: reason
                });
            }
        }

        await user.send({
            embeds: [{
                description: message,
                color: 0xFFA500, // Orange color for warnings
                timestamp: new Date().toISOString()
            }]
        });

        console.log(`Notified user ${user.tag} about inaccessible channel ${channelId}`);
        return true;
    } catch (e) {
        console.error(`Failed to notify user ${id} about inaccessible channel:`, e.message);
        return false;
    }
}

export const testAlerts = async (interaction) => {
    try {
        const channel = interaction.channel || await fetchChannel(interaction.channel_id);
        await channel.send({
            embeds: [basicEmbed(s(interaction).info.ALERT_TEST)]
        });
        return true;
    } catch(e) {
        console.error(`${interaction.user.tag} tried to /testalerts, but failed!`);
        if(e.code === 50013) console.error("Failed with 'Missing Access' error");
        else if(e.code === 50001) console.error("Failed with 'Missing Permissions' error");
        else console.error(e);
        return false;
    }
}

export const fetchAlerts = async (interaction) => {
    const auth = await authUser(interaction.user.id);
    if(!auth.success) return authFailureMessage(interaction, auth, s(interaction).error.AUTH_ERROR_ALERTS);

    const channel = interaction.channel || await fetchChannel(interaction.channelId);
    const emojiString = await VPEmoji(interaction, channel);

    return await alertsPageEmbed(interaction, await filteredAlertsForUser(interaction), 0, emojiString);
}

export const debugCheckAlerts = async () => {
    const debugLog = [];
    const log = (message, level = 'INFO') => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level}] ${message}`;
        console.log(logMessage);
        debugLog.push(logMessage);
    };

    log('=== Starting Debug Alert Check (DRY RUN - No messages will be sent) ===', 'DEBUG');
    
    try {
        let totalUsers = 0;
        let usersWithAlerts = 0;
        let usersWithDailyShop = 0;
        let unreachableChannels = new Map(); // channelId -> {reason, count}
        let reachableChannels = new Set();

        for(const id of getUserList()) {
            totalUsers++;
            
            try {
                const userJson = readUserJson(id);
                if(!userJson) {
                    log(`User ${id}: No JSON data found`, 'WARN');
                    continue;
                }

                const discordUser = await client.users.fetch(id).catch(() => null);
                const discordUsername = discordUser ? `${discordUser.username} (${id})` : id;

                const accountCount = userJson.accounts.length;
                log(`\n--- User: ${discordUsername} (${accountCount} account${accountCount !== 1 ? 's' : ''}) ---`);

                for(let i = 1; i <= accountCount; i++) {
                    const rawUserAlerts = alertsForUser(id, i);
                    const dailyShopChannel = getSetting(id, "dailyShop");
                    
                    if(!rawUserAlerts?.length && !dailyShopChannel) {
                        log(`  Account ${i}/${accountCount}: No alerts or daily shop configured`, 'DEBUG');
                        continue;
                    }

                    const valorantUser = getUser(id, i);
                    if(!valorantUser) {
                        log(`  Account ${i}/${accountCount}: Could not load Valorant user data`, 'ERROR');
                        continue;
                    }

                    log(`  Account ${i}/${accountCount}: ${valorantUser.username}`);

                    // Check daily shop channel
                    if(dailyShopChannel && i === userJson.currentAccount) {
                        usersWithDailyShop++;
                        log(`    Daily Shop: Enabled for channel ID ${dailyShopChannel}`);
                        
                        const channel = await fetchChannel(dailyShopChannel).catch(e => {
                            log(`    Daily Shop Channel: ERROR fetching - ${e.message}`, 'ERROR');
                            return null;
                        });

                        if(!channel) {
                            const reason = await diagnoseChannelIssue(dailyShopChannel, id);
                            log(`    Daily Shop Channel: ❌ UNREACHABLE - ${reason}`, 'ERROR');
                            const key = `${dailyShopChannel}`;
                            if(!unreachableChannels.has(key)) {
                                unreachableChannels.set(key, {reason, count: 0, type: 'dailyShop', users: []});
                            }
                            unreachableChannels.get(key).count++;
                            unreachableChannels.get(key).users.push(discordUsername);
                        } else {
                            log(`    Daily Shop Channel: ✓ Accessible in guild "${channel.guild?.name || 'DM'}" #${channel.name}`, 'INFO');
                            reachableChannels.add(dailyShopChannel);
                        }
                    } else if(dailyShopChannel && i !== userJson.currentAccount) {
                        log(`    Daily Shop: Configured but skipped (not current account)`, 'DEBUG');
                    }

                    // Check alerts
                    if(rawUserAlerts?.length) {
                        usersWithAlerts++;
                        const userAlerts = removeDupeAlerts(rawUserAlerts);
                        log(`    Alerts: ${userAlerts.length} skin alert${userAlerts.length !== 1 ? 's' : ''} configured`);

                        const channelGroups = {};
                        for(const alert of userAlerts) {
                            if(!channelGroups[alert.channel_id]) channelGroups[alert.channel_id] = [];
                            channelGroups[alert.channel_id].push(alert);
                        }

                        for(const [channelId, alerts] of Object.entries(channelGroups)) {
                            const channel = await fetchChannel(channelId).catch(e => {
                                log(`      Alert Channel ${channelId}: ERROR fetching - ${e.message}`, 'ERROR');
                                return null;
                            });

                            if(!channel) {
                                const reason = await diagnoseChannelIssue(channelId, id);
                                log(`      Alert Channel ${channelId}: ❌ UNREACHABLE - ${reason}`, 'ERROR');
                                log(`        ${alerts.length} alert${alerts.length !== 1 ? 's' : ''} would fail to send`, 'ERROR');
                                
                                const key = `${channelId}`;
                                if(!unreachableChannels.has(key)) {
                                    unreachableChannels.set(key, {reason, count: 0, type: 'alert', users: [], skins: []});
                                }
                                unreachableChannels.get(key).count += alerts.length;
                                unreachableChannels.get(key).users.push(discordUsername);
                                
                                for(const alert of alerts) {
                                    const skin = await getSkin(alert.uuid);
                                    unreachableChannels.get(key).skins.push(l(skin.names));
                                }
                            } else {
                                log(`      Alert Channel ${channelId}: ✓ Accessible in guild "${channel.guild?.name || 'DM'}" #${channel.name}`, 'INFO');
                                reachableChannels.add(channelId);
                                for(const alert of alerts) {
                                    const skin = await getSkin(alert.uuid);
                                    log(`        - ${l(skin.names)} (${alert.uuid})`, 'DEBUG');
                                }
                            }
                        }
                    }
                }
            } catch(e) {
                log(`User ${id}: ERROR during check - ${e.message}`, 'ERROR');
                log(e.stack, 'ERROR');
            }
        }

        // Summary
        log('\n=== DEBUG SUMMARY ===', 'INFO');
        log(`Total users checked: ${totalUsers}`);
        log(`Users with alerts: ${usersWithAlerts}`);
        log(`Users with daily shop: ${usersWithDailyShop}`);
        log(`Reachable channels: ${reachableChannels.size}`);
        log(`Unreachable channels: ${unreachableChannels.size}`);

        if(unreachableChannels.size > 0) {
            log('\n=== UNREACHABLE CHANNELS DETAIL ===', 'ERROR');
            for(const [channelId, info] of unreachableChannels) {
                log(`\nChannel ID: ${channelId}`, 'ERROR');
                log(`  Issue: ${info.reason}`, 'ERROR');
                log(`  Type: ${info.type}`, 'ERROR');
                log(`  Affected: ${info.count} alert${info.count !== 1 ? 's' : ''}`, 'ERROR');
                log(`  Users: ${info.users.join(', ')}`, 'ERROR');
                if(info.skins && info.skins.length > 0) {
                    log(`  Skins: ${info.skins.join(', ')}`, 'ERROR');
                }
            }
        }

        log('\n=== Debug Alert Check Complete ===', 'DEBUG');
        return debugLog.join('\n');
    } catch(e) {
        log(`FATAL ERROR during debug check: ${e.message}`, 'ERROR');
        log(e.stack, 'ERROR');
        return debugLog.join('\n');
    }
}

async function diagnoseChannelIssue(channelId, userId) {
    try {
        // Try to get the channel from cache first
        const cachedChannel = client.channels.cache.get(channelId);
        if(cachedChannel) {
            // Channel exists in cache, might be a permissions issue
            try {
                if(cachedChannel.guild) {
                    const permissions = cachedChannel.permissionsFor(client.user);
                    if(!permissions.has('ViewChannel')) return 'Bot lacks ViewChannel permission';
                    if(!permissions.has('SendMessages')) return 'Bot lacks SendMessages permission';
                }
                return 'Channel exists but fetchChannel failed (unknown issue)';
            } catch(e) {
                return `Permission check failed: ${e.message}`;
            }
        }

        // Try to fetch the channel
        try {
            const channel = await client.channels.fetch(channelId);
            if(!channel) return 'Channel not found (may be deleted)';
            
            // If we got here, channel exists but wasn't in cache
            if(channel.guild) {
                const bot = await channel.guild.members.fetch(client.user.id).catch(() => null);
                if(!bot) return 'Bot not in guild (kicked or guild deleted)';
                
                const permissions = channel.permissionsFor(client.user);
                if(!permissions.has('ViewChannel')) return 'Bot lacks ViewChannel permission';
                if(!permissions.has('SendMessages')) return 'Bot lacks SendMessages permission';
            }
            
            return 'Channel accessible but fetchChannel returned null (unknown)';
        } catch(e) {
            if(e.code === 10003) return 'Channel deleted or does not exist';
            if(e.code === 50001) return 'Bot lacks access to channel';
            if(e.code === 50013) return 'Bot lacks permissions';
            return `Fetch failed: ${e.code ? `Discord error ${e.code}` : e.message}`;
        }
    } catch(e) {
        return `Diagnosis failed: ${e.message}`;
    }
}
