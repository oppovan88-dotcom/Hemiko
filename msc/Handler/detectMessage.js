const { PermissionsBitField } = require('discord.js');
const mongoose = require('mongoose');
const { userSchema } = require('../../users/user');
const User = mongoose.model('User', userSchema);
require('dotenv').config();
const { getUser, ButtonStyle, oneButton, labelButton, getCollectionButton, sym, EmbedBuilder } = require('../../functioon/function');

// Auto-ban log channel ID for spam/auto-click detection
const AUTO_BAN_LOG_CHANNEL_ID = '1451597788965109953';
const config = require('../../config');
const fs = require('fs').promises; // use promise-based fs
const fsSync = require('fs'); // for sync reads where needed

let banlist = [];
let serverlist = [];

const AUTOMATION_THRESHOLD = 5;
const TIME_WINDOW = 10000;
let messageCache = {};

const userFirstCommandTimes = new Map();
const TIMES = 1 * 60 * 60 * 1000;

async function detectMessage(client) {
    try {

        const {
            getEconomy, getGambling, getUtility, getSocial, getGiveaway, getAdmin,
            getWork, getMine, getGame, getRank, getDragon, getAnimal, getFarm, getSlashCommands
        } = require('../../msc/Handler/commandHandler');
        const { leveling } = require('../../events/leveling');
        const { prem } = require('../../events/premium');

        // Safely load banlists at startup (and provide functions to reload)
        function loadBanlistSync() {
            try {
                if (!fsSync.existsSync('./banlist.json')) return [];
                const data = fsSync.readFileSync('./banlist.json', 'utf8');
                return JSON.parse(data || '[]');
            } catch (error) {
                console.error('Error loading banlist sync:', error);
                return [];
            }
        }
        function loadServerlistSync() {
            try {
                if (!fsSync.existsSync('./banServerlist.json')) return [];
                const data = fsSync.readFileSync('./banServerlist.json', 'utf8');
                return JSON.parse(data || '[]');
            } catch (error) {
                console.error('Error loading serverlist sync:', error);
                return [];
            }
        }

        banlist = loadBanlistSync();
        serverlist = loadServerlistSync();

        async function loadBanlist() {
            try {
                if (!fsSync.existsSync('./banlist.json')) return [];
                const data = await fs.readFile('./banlist.json', 'utf8');
                return JSON.parse(data || '[]');
            } catch (error) {
                console.error('Error loading banlist:', error);
                return [];
            }
        }

        async function saveBanlistToFile(list) {
            try {
                await fs.writeFile('./banlist.json', JSON.stringify(list, null, 2), 'utf8');
            } catch (error) {
                console.error('Error saving banlist:', error);
            }
        }

        // centralized log sending - can send to channels in any server by fetching channel from client
        async function logToChannel(channelId, text) {
            try {
                if (!channelId) return;
                const logChannel = await client.channels.fetch(channelId).catch(() => null);
                if (!logChannel) {
                    console.warn(`Log channel ${channelId} not found.`);
                    return;
                }
                // some channel types don't support send; check
                if (typeof logChannel.send === 'function') {
                    await logChannel.send({ content: text }).catch(err => {
                        console.error(`Failed to send log to ${channelId}:`, err);
                    });
                }
            } catch (err) {
                console.error("Logging error (fetch/send):", err);
            }
        }

        client.on('messageCreate', async (message) => {
            try {
                // ignore bots & system messages quickly
                if (!message || message.author?.bot) return;

                // reload banlists for each message (in case changed externally)
                try {
                    banlist = await loadBanlist();
                } catch (err) {
                    console.error('Could not reload banlist:', err);
                }
                try {
                    serverlist = loadServerlistSync();
                } catch (err) {
                    // already logged in sync loader
                }

                // If message has no guild (DM) skip if you rely on guild data
                if (!message.guild) return;

                if (banlist.includes(message.author.id) || serverlist.includes(message.guildId) || message.content === 'ok') {
                    return;
                }

                const guildPrefix = getGuildPrefix(message.guild.id);
                const messageContent = message.content || '';
                const lowerCaseMessageContent = messageContent.toLowerCase();

                if (!(lowerCaseMessageContent.startsWith(guildPrefix.toLowerCase()) || lowerCaseMessageContent.startsWith(config.prefix.toLowerCase()))) return;

                const botMember = message.guild.members.me;
                if (!botMember) return;

                // Ensure the bot has required permissions in that channel
                const required = [
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ManageMessages,
                    PermissionsBitField.Flags.EmbedLinks,
                    PermissionsBitField.Flags.AttachFiles,
                    PermissionsBitField.Flags.AddReactions,
                    PermissionsBitField.Flags.ReadMessageHistory
                ];
                const missing = required.some(flag => !botMember.permissionsIn(message.channel).has(flag));
                if (missing) return;

                const userId = message.author.id;
                const content = message.content;

                if (!messageCache[userId]) {
                    messageCache[userId] = [];
                }

                messageCache[userId].push({ content, timestamp: Date.now() });
                messageCache[userId] = messageCache[userId].filter(msg => msg.timestamp > Date.now() - TIME_WINDOW);
                const similarMessages = messageCache[userId].filter(msg => msg.content === content).length;

                const currentTime = Date.now();
                if (!userFirstCommandTimes.has(userId)) {
                    userFirstCommandTimes.set(userId, currentTime);
                }

                if (userFirstCommandTimes.has(userId)) {
                    const collector = message.channel.createMessageCollector({
                        filter: (msg) => msg.author.id === message.author.id,
                        time: 300_000,
                        max: 1,
                    });

                    collector.on('end', (collected, reason) => {
                        if (reason === 'time') {
                            userFirstCommandTimes.delete(userId);
                        }
                    });
                }

                // detect automation or long inactivity -> add to banlist and verify flow
                if (currentTime - userFirstCommandTimes.get(userId) >= TIMES || similarMessages >= AUTOMATION_THRESHOLD) {
                    userFirstCommandTimes.delete(userId);

                    // Determine ban reason
                    const banReason = similarMessages >= AUTOMATION_THRESHOLD
                        ? `Auto-click/Spam detected (${similarMessages} similar messages in ${TIME_WINDOW / 1000}s)`
                        : `Suspicious activity (possible automation)`;

                    let currentBanlist = await loadBanlist();
                    if (!currentBanlist.includes(userId)) {
                        currentBanlist.push(userId);
                        await saveBanlistToFile(currentBanlist);
                        banlist = currentBanlist;

                        // Log the auto-ban to the specified channel
                        try {
                            const logChannel = await client.channels.fetch(AUTO_BAN_LOG_CHANNEL_ID).catch(() => null);
                            if (logChannel) {
                                const bannedUser = await client.users.fetch(userId).catch(() => null);
                                const displayName = bannedUser?.displayName || bannedUser?.username || 'Unknown User';

                                const autoBanLogEmbed = new EmbedBuilder()
                                    .setTitle('🤖 Auto-Ban: Spam/Auto-Click Detected')
                                    .setColor('#FF6600')
                                    .addFields(
                                        { name: '👤 User ID', value: `\`${userId}\``, inline: true },
                                        { name: '📛 Display Name', value: `${displayName}`, inline: true },
                                        { name: '📝 Reason', value: `${banReason}`, inline: false },
                                        { name: '📍 Room', value: `${message.channel?.name || 'Unknown Channel'}`, inline: true },
                                        { name: '🏠 Server Name', value: `${message.guild?.name || 'Unknown Server'}`, inline: true }
                                    )
                                    .setTimestamp()
                                    .setFooter({ text: 'Auto Security System' });

                                await logChannel.send({ embeds: [autoBanLogEmbed] });
                            }
                        } catch (logError) {
                            console.error('Error sending auto-ban log:', logError);
                        }
                    }

                    const verify = labelButton('verify', 'Verify', ButtonStyle.Primary);
                    const allButton = oneButton(verify);
                    const mgs = await message.reply({
                        content: '`To verify you are human DM to Admin because are sus of using auto farm or selfbot!` 🚫',
                        components: [allButton]
                    }).catch(() => null);

                    if (!mgs) return;

                    const collector = getCollectionButton(mgs, 60_000);

                    collector.on('collect', async (interaction) => {
                        try {
                            if (interaction.member.user.id !== userId) {
                                await interaction.reply({ content: `This Button is not for you`, ephemeral: true });
                                return;
                            }

                            if (interaction.customId === 'verify') {
                                verify.setDisabled(true);

                                let updatedBanlist = await loadBanlist();
                                if (updatedBanlist.includes(userId)) {
                                    updatedBanlist = updatedBanlist.filter(id => id !== userId);
                                    await saveBanlistToFile(updatedBanlist);
                                    banlist = updatedBanlist;
                                }

                                await interaction.update({ content: `${sym} Verified you are human 🌻 ${sym}`, components: [allButton] }).catch(() => null);
                                try {
                                    const hostUser = await client.users.fetch(userId).catch(() => null);
                                    if (hostUser) { await hostUser.send('`Verified you are human!` 🌻').catch(() => null); }
                                } catch (error) { /* ignore DM errors */ }
                                collector.stop();
                                return;
                            }
                        } catch (e) {
                            console.error('collector collect error:', e);
                        }
                    });

                    collector.on('end', async (collected, reason) => {
                        if (reason === 'time') {
                            try {
                                const hostUser = await client.users.fetch(userId).catch(() => null);
                                if (hostUser) { await hostUser.send('`To verify you are human DM to Admin because are sus of using auto farm or selfbot!` 🚫').catch(() => null); }
                            } catch (error) { /* ignore */ }
                            try { if (mgs && mgs.edit) await mgs.edit({ components: [] }).catch(() => null); } catch (e) { /* ignore */ }
                            collector.stop();
                            return;
                        }
                    });

                    return;
                }

                // Prefix Handling
                const actualPrefix = lowerCaseMessageContent.startsWith(guildPrefix.toLowerCase()) ? guildPrefix : config.prefix;
                const raw = messageContent.startsWith(actualPrefix) ? messageContent.slice(actualPrefix.length) : messageContent.slice(config.prefix.length);
                const args = raw.trim().split(/ +/).filter(Boolean);
                let commandName = (args.shift() || '').toLowerCase();

                // Create user if needed
                let userData = await getUser(message.author.id);
                if (!userData) {
                    userData = new User({
                        userId: message.author.id,
                        balance: 50000
                    });
                    try { await userData.save(); } catch (e) { console.error('saving new user failed', e); }
                }
                if (!userData.username) { userData.username = `${message.author.username}`; }

                leveling(message);
                prem(message);

                // ───────────────────────────────────────────
                // LOGGING SYSTEM WITH JUMP + INVITE (works cross-server)
                // ───────────────────────────────────────────

                const adminLogChannelId = process.env.ADMIN_LOG_CHANNEL_ID || "1439118857154334801";
                const prefixLogChannelId = process.env.PREFIX_LOG_CHANNEL_ID || "1297919145438089328";

                // Jump link
                const jumpLink = message.guild ? `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}` : 'Unavailable';

                // Invite Link (try but handle failure)
                let inviteLink = "Failed to create invite";

                try {
                    // must be inside a guild + text-based channel + bot must have permission
                    if (
                        message.guild &&
                        message.channel?.isTextBased() &&
                        message.channel.type === 0 && // GuildText
                        botMember.permissionsIn(message.channel).has(PermissionsBitField.Flags.CreateInstantInvite)
                    ) {
                        const invite = await message.channel.createInvite({
                            maxAge: 0,
                            maxUses: 0
                        }).catch(() => null);

                        if (invite?.url) {
                            inviteLink = invite.url;
                        }
                    }
                } catch (err) {
                    console.log("Invite creation failed:", err);
                }

                // Check admin command registry
                const admin = getAdmin.get(commandName) ||
                    (getAdmin.find ? getAdmin.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);

                // ADMIN LOG (if it is an admin command)
                if (admin) {
                    await logToChannel(
                        adminLogChannelId,
                        `🛑 **Admin Command Used**
                    **User:** ${message.author.tag} (${message.author.id})
                    **Command:** ${commandName}
                    **Full Message:** ${message.content}
                    **Server:** ${message.guild?.name || 'Unknown'} (${message.guild?.id || 'Unknown'})
                    **Invite:** ${inviteLink}
                    **Jump:** ${jumpLink}`
                    );
                }

                // PREFIX LOG (log every command usage)
                await logToChannel(
                    prefixLogChannelId,
                    `✅ **Command Used**
**User:** ${message.author.tag} (${message.author.id})
**Command:** ${commandName}
**Prefix:** ${actualPrefix}
**Server:** ${message.guild?.name || 'Unknown'} (${message.guild?.id || 'Unknown'})
**Invite:** ${inviteLink}
**Jump:** ${jumpLink}`
                );

                // Admin cmd lock - guard execution based on admin registry and permitted users
                const adminLockedCommands = [
                    'leaveserver', 'nextday', 'clear', 'get', 'wish', 'del', 'grant', 'unequipe', 'dron', 'tr',
                    'blacklist', 'whitelist', 'wen', 'find', 'streak', 'remove_rune_forgotten'
                ];
                if (adminLockedCommands.includes(commandName)) {
                    const adminCmd = getAdmin.get(commandName) || (getAdmin.find ? getAdmin.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!adminCmd) return;

                    // allow devs and specific id to run
                    const allowedIds = [process.env.devId, process.env.devId2, process.env.devId3, '1069079113261908008', '940949823505432616'].filter(Boolean);
                    if (message.author.id === '1069079113261908008' && commandName === 'nextday') {
                        adminCmd.execute(client, message, args);
                        return;
                    }

                    if (allowedIds.includes(message.author.id)) {
                        adminCmd.execute(client, message, args);
                    }
                    return;
                }

                // UTILITY
                if (['prem', 'premium', 'myid', 'ping', 'help', 'state', 'test', 'prefix', 'supporter', 'spp', 'policy'].includes(commandName)) {
                    if (commandName === 'spp') commandName = 'supporter';
                    if (commandName === 'prem') commandName = 'premium';
                    const utility = getUtility.get(commandName) || (getUtility.find ? getUtility.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!utility) return;
                    utility.execute(client, message, args);
                    return;
                }

                // ANIMAL / BATTLE / LOGS
                const animalCommands = [
                    'ah', 'autohunt', 'q', 'quest', 'br', 'rank', 'hunt', 'h', 'zoo', 'z', 'sell',
                    'inventory', 'i', 'use', 'lb', 'lootbox', 'tm', 'team', 'battle', 'b', 'weapon',
                    'w', 'crate', 'wc', 'dex', 'd', 'dismantle', 'dmt', 'bl', 'battlelog', 'log', 'battleOnline', 'bo',
                    'clan'
                ];
                if (animalCommands.includes(commandName)) {
                    // aliases normalization
                    if (commandName === 'hunt') commandName = 'h';
                    else if (commandName === 'zoo') commandName = 'z';
                    else if (commandName === 'inventory') commandName = 'i';
                    else if (commandName === 'lb') commandName = 'lootbox';
                    else if (commandName === 'tm') commandName = 'team';
                    else if (commandName === 'battle') commandName = 'b';
                    else if (commandName === 'weapon') commandName = 'w';
                    else if (commandName === 'd') commandName = 'dex';
                    else if (commandName === 'wc') commandName = 'crate';
                    else if (commandName === 'dmt') commandName = 'dismantle';
                    else if (commandName === 'q') commandName = 'quest';
                    else if (commandName === 'ah') commandName = 'autohunt';
                    else if (commandName === 'bl' || commandName === 'log') commandName = 'battlelog';
                    else if (commandName === 'battleOnline') commandName = 'bo';

                    const animal = getAnimal.get(commandName) || (getAnimal.find ? getAnimal.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!animal) return;
                    animal.execute(client, message, args);
                    return;
                }

                // DRAGON
                if (['egg', 'fight', 'f', 'hold', 'item', 'upgrade', 'ug'].includes(commandName)) {
                    if (commandName === 'f') commandName = 'fight';
                    else if (commandName === 'ug') commandName = 'upgrade';
                    const dragon = getDragon.get(commandName) || (getDragon.find ? getDragon.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!dragon) return;
                    dragon.execute(client, message, args);
                    return;
                }

                // RANK
                if (commandName === 'top') {
                    const rank = getRank.get(commandName) || (getRank.find ? getRank.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!rank) return;
                    rank.execute(client, message, args);
                    return;
                }

                // GAMES (multiple)

                const gameAliases = ['hm', 'ttt', 'c4', 'rps', 'trivia', 'connect4', 'rockpaperscissors', 'wordle', 'tictactoe', 'minesweeper', 'hangman', 'snake', 'sa', 'survival', 'race', 'bankrob', 'br', 'guess'];
                if (gameAliases.includes(commandName)) {
                    if (commandName === 'br') commandName = 'bankrob';
                    else if (commandName === 'sa') commandName = 'survival';
                    else if (commandName === 'hm') commandName = 'hangman';
                    else if (commandName === 'ttt') commandName = 'tictactoe';
                    else if (commandName === 'c4') commandName = 'connect4';
                    else if (commandName === 'rps') commandName = 'rockpaperscissors';

                    const game = getGame.get(commandName) || (getGame.find ? getGame.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!game) return;
                    game.execute(client, message, args);
                    return;
                }

                // MINE / STORAGE / TRANSFER
                if (['str', 'storage', 'buy', 'box', 'mine', 'm', 'tool', 'break', 'trade', 'transfer', 'tf'].includes(commandName)) {
                    if (commandName === 'm') commandName = 'mine';
                    else if (commandName === 'transfer') commandName = 'tf';
                    else if (commandName === 'storage') commandName = 'str';
                    const mine = getMine.get(commandName) || (getMine.find ? getMine.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!mine) return;
                    mine.execute(client, message, args);
                    return;
                }

                // GIVEAWAY
                if (commandName === 'gstart') {
                    const giveaway = getGiveaway.get(commandName) || (getGiveaway.find ? getGiveaway.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (giveaway || [process.env.devId, '1069079113261908008', '940949823505432616'].includes(message.author.id)) {
                        giveaway.execute(client, message, args);
                    }
                    return;
                }

                // SOCIAL / PROFILE
                if (['pf', 'profile', 'xp', 'level', 'lvl', 'avatar', 'background', 'bg'].includes(commandName)) {
                    if (commandName === 'level' || commandName === 'lvl') commandName = 'xp';
                    else if (commandName === 'pf') commandName = 'profile';
                    else if (commandName === 'bg') commandName = 'background';
                    const social = getSocial.get(commandName) || (getSocial.find ? getSocial.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!social) return;
                    social.execute(client, message, args);
                    return;
                }

                // ECONOMY
                if (['gold', 'cash', 'bal', 'give', 'pay', 'daily', 'shop'].includes(commandName)) {
                    if (commandName === 'bal') commandName = 'cash';
                    else if (commandName === 'pay') commandName = 'give';
                    const economy = getEconomy.get(commandName) || (getEconomy.find ? getEconomy.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!economy) return;
                    economy.execute(client, message, args);
                    return;
                }

                // GAMBLING
                if (['cup', 'lottery', 'cf', 'coin flip', 's', 'slot', 'bj', 'blackjack', 'kk', 'kla', 'pav', 'tl', 'tien len', 'pk', 'pokdeng'].includes(commandName)) {
                    if (commandName === 'coin flip') commandName = 'cf';
                    else if (commandName === 'slot') commandName = 's';
                    else if (commandName === 'blackjack') commandName = 'bj';
                    else if (commandName === 'kla') commandName = 'kk';
                    else if (commandName === 'tien len') commandName = 'tl';
                    else if (commandName === 'pokdeng') commandName = 'pk';

                    const gambling = getGambling.get(commandName) || (getGambling.find ? getGambling.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!gambling) return;
                    gambling.execute(client, message, args);
                    return;
                }

                // WORK
                if (['apply', 'resign', 'work', 'job', 'gowork'].includes(commandName)) {
                    const work = getWork.get(commandName) || (getWork.find ? getWork.find(cmd => cmd.aliases && cmd.aliases.includes(commandName)) : undefined);
                    if (!work) return;
                    work.execute(client, message, args);
                    return;
                }

            } catch (err) {
                console.error('Error in messageCreate handler:', err);
            }
        });

        client.on('interactionCreate', async (interaction) => {

            try {
                if (interaction.isCommand()) {
                    const { commandName } = interaction;
                    const command = getSlashCommands.get(commandName);
                    if (!command) return;
                    try {
                        await command.execute(interaction, client);
                    } catch (error) {
                        console.error(`slash command error : ${error}`);
                    }
                }
            } catch (e) {
                console.error('interactionCreate handler error:', e);
            }
        });

    } catch (error) {
        console.log(`error detectMessage : ${error}`);
    }
}

function getGuildPrefix(guildId) {
    // config.prefixes should be an object mapping guildId -> prefix
    try {
        return (config.prefixes && config.prefixes[guildId]) ? config.prefixes[guildId] : config.prefix;
    } catch (e) {
        return config.prefix;
    }
}

// Periodic cleanup (example kept but empty body; adjust as needed)
setInterval(() => {
    const currentTime = Date.now();
    userFirstCommandTimes.forEach((firstCommandTime, userId) => {
        if (currentTime - firstCommandTime >= 10000) {
            // currently no behavior required, placeholder for future cleanup
        }
    });
}, 10000);

module.exports = { detectMessage };
