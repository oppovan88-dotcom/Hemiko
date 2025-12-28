const { getUser, SimpleEmbed, gif, cooldown, customEmbed } = require('../../functioon/function');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { BakongKHQR, khqrData } = require('bakong-khqr');
require('dotenv').config();

const cooldowns = new Map();
let CDT = 15_000; // 15 second cooldown
var getId = [];
var cdId = [];
var prem = [];

// Log channel for gold purchases
const GOLD_PURCHASE_LOG_CHANNEL_ID = '1454885535494443038';

// ======================== BAKONG WING CONFIGURATION (from .env) ========================
const BAKONG_CONFIG = {
    // Bakong Account ID (from .env) - format: username@bank
    accountNumber: process.env.BAKONG_ACCOUNT_NUMBER || 'sovan_narith@wing',
    merchantName: process.env.BAKONG_MERCHANT_NAME || 'AceZero Gold Shop',
    merchantCity: process.env.BAKONG_MERCHANT_CITY || 'Phnom Penh',

    // API Token for transaction verification (from .env)
    apiToken: process.env.BAKONG_API_TOKEN || '',

    // Exchange Rate: Gold per 1 USD (from .env)
    goldPerUSD: parseInt(process.env.BAKONG_GOLD_PER_USD) || 100,

    // Minimum and Maximum purchase amounts (from .env)
    minUSD: parseInt(process.env.BAKONG_MIN_USD) || 1,
    maxUSD: parseInt(process.env.BAKONG_MAX_USD) || 100
};

// ======================== QR CODE GENERATION ========================
/**
 * Generate expiration timestamp for dynamic QR (10 minutes from now)
 * Format: Unix timestamp in milliseconds
 */
function getExpirationTimestamp() {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 10); // 10 minutes expiry
    return now.getTime().toString(); // Unix timestamp in milliseconds
}

/**
 * Generate KHQR code data for payment with AMOUNT included (dynamic QR)
 * @param {number} amountUSD - Amount in USD
 * @param {string} transactionId - Unique transaction reference
 * @returns {object} - QR code data
 */
function generateKHQRData(amountUSD, transactionId) {
    try {
        // Calculate expiration timestamp (required for dynamic QR with amount)
        const expirationTimestamp = getExpirationTimestamp();

        // Create Individual Info for KHQR with AMOUNT (dynamic QR)
        const individualInfo = {
            bakongAccountID: BAKONG_CONFIG.accountNumber,
            merchantName: BAKONG_CONFIG.merchantName,
            merchantCity: BAKONG_CONFIG.merchantCity,
            currency: khqrData.currency.usd,
            amount: amountUSD, // <-- This makes it a DYNAMIC QR with pre-filled amount!
            expirationTimestamp: expirationTimestamp, // Required for dynamic QR
            billNumber: transactionId,
            storeLabel: BAKONG_CONFIG.merchantName,
            terminalLabel: 'BOT'
        };

        // Generate KHQR
        const khqr = new BakongKHQR();
        const qrResult = khqr.generateIndividual(individualInfo);

        // Check if generation was successful
        if (qrResult.status.code !== 0 || !qrResult.data) {
            console.error('KHQR Generation Failed:', qrResult.status);
            return {
                success: false,
                error: qrResult.status.message || 'QR generation failed'
            };
        }

        return {
            success: true,
            qrString: qrResult.data.qr,
            md5: qrResult.data.md5,
            transactionId: transactionId,
            amountUSD: amountUSD,
            expirationTimestamp: expirationTimestamp
        };
    } catch (error) {
        console.error('KHQR Generation Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Generate QR Code image from text
 * @param {string} text - QR code content
 * @returns {Buffer} - PNG image buffer
 */
async function generateQRImage(text) {
    const QRCode = require('qrcode');
    const buffer = await QRCode.toBuffer(text, {
        type: 'png',
        width: 350,
        margin: 2,
        color: {
            dark: '#000000',
            light: '#FFFFFF'
        }
    });
    return buffer;
}

/**
 * Check payment status via Bakong API
 * @param {string} md5 - MD5 hash of the QR code
 * @returns {object} - Payment status
 */
async function checkPaymentStatus(md5) {
    const axios = require('axios');
    try {
        console.log(`[Bakong] Checking payment for MD5: ${md5}`);

        const response = await axios.post(
            'https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5',
            { md5: md5 },
            {
                headers: {
                    'Authorization': `Bearer ${BAKONG_CONFIG.apiToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        console.log(`[Bakong] API Response:`, JSON.stringify(response.data));

        // Check if payment was successful
        // responseCode === 0 means success, or check for data.data array
        if (response.data) {
            // Check various success indicators
            if (response.data.responseCode === 0 ||
                (response.data.data && response.data.data.length > 0)) {
                console.log(`[Bakong] Payment CONFIRMED!`);
                return {
                    success: true,
                    paid: true,
                    data: response.data
                };
            }
        }

        console.log(`[Bakong] Payment NOT found yet`);
        return {
            success: true,
            paid: false,
            data: response.data
        };
    } catch (error) {
        console.error('[Bakong] Payment Check Error:', error.response?.data || error.message);
        return {
            success: false,
            paid: false,
            error: error.message
        };
    }
}

// ======================== PENDING TRANSACTIONS STORE ========================
const pendingTransactions = new Map();

module.exports = {
    name: 'buygold',
    aliases: ['topup', 'recharge', 'purchasegold'],
    async execute(client, message, args) {
        try {
            const user = message.author;
            const userData = await getUser(user.id);

            if (!userData) return;

            // Premium cooldown reduction
            if (userData.premium.premium_bool && !prem.includes(user.id)) {
                prem.push(user.id);
            }

            // Cooldown check
            if (cooldown(user.id, getId, cdId, CDT, message, cooldowns, prem)) {
                return;
            }

            // Parse amount from args
            let amountUSD = parseFloat(args[0]);

            // Show help if no amount provided
            if (!args[0] || isNaN(amountUSD)) {
                const helpEmbed = customEmbed()
                    .setColor('#FFD700')
                    .setTitle('💰 Buy Gold with Wing/Bakong')
                    .setDescription(
                        `Purchase Gold using **Wing** or **Bakong** payment!\n\n` +
                        `**Exchange Rate:** ${gif.gold_coin} **${BAKONG_CONFIG.goldPerUSD} Gold** = **$1 USD**\n\n` +
                        `**Usage:** \`Zbuygold <amount_usd>\`\n\n` +
                        `**Examples:**\n` +
                        `• \`Zbuygold 1\` → Buy ${gif.gold_coin} **100 Gold** for **$1**\n` +
                        `• \`Zbuygold 5\` → Buy ${gif.gold_coin} **500 Gold** for **$5**\n` +
                        `• \`Zbuygold 10\` → Buy ${gif.gold_coin} **1,000 Gold** for **$10**\n\n` +
                        `**Limits:**\n` +
                        `• Minimum: **$${BAKONG_CONFIG.minUSD}** (${BAKONG_CONFIG.minUSD * BAKONG_CONFIG.goldPerUSD} Gold)\n` +
                        `• Maximum: **$${BAKONG_CONFIG.maxUSD}** (${BAKONG_CONFIG.maxUSD * BAKONG_CONFIG.goldPerUSD} Gold)\n\n` +
                        `**Payment Methods:**\n` +
                        `• 📱 **Wing App** (Scan QR)\n` +
                        `• 🏦 **Bakong App** (Scan QR)\n` +
                        `• 🏧 **Any KHQR-enabled bank** (ABA, ACLEDA, etc.)`
                    )
                    .setFooter({ text: 'Powered by Bakong KHQR' })
                    .setTimestamp();

                return message.channel.send({ embeds: [helpEmbed] });
            }

            // Validate amount
            if (amountUSD < BAKONG_CONFIG.minUSD) {
                return message.channel.send({
                    embeds: [SimpleEmbed(`❌ Minimum purchase is **$${BAKONG_CONFIG.minUSD}** (${BAKONG_CONFIG.minUSD * BAKONG_CONFIG.goldPerUSD} Gold)`)]
                });
            }

            if (amountUSD > BAKONG_CONFIG.maxUSD) {
                return message.channel.send({
                    embeds: [SimpleEmbed(`❌ Maximum purchase is **$${BAKONG_CONFIG.maxUSD}** (${BAKONG_CONFIG.maxUSD * BAKONG_CONFIG.goldPerUSD} Gold)`)]
                });
            }

            // Calculate gold amount
            const goldAmount = Math.floor(amountUSD * BAKONG_CONFIG.goldPerUSD);

            // Generate unique transaction ID
            const transactionId = `AZ-${user.id.slice(-6)}-${Date.now().toString(36).toUpperCase()}`;

            // Generate KHQR with AMOUNT included (dynamic QR)
            const qrData = generateKHQRData(amountUSD, transactionId);

            if (!qrData.success) {
                return message.channel.send({
                    embeds: [SimpleEmbed(`❌ Failed to generate payment QR code.\n\nError: ${qrData.error}`)]
                });
            }

            // Generate QR Code Image
            let qrImageBuffer;
            try {
                qrImageBuffer = await generateQRImage(qrData.qrString);
            } catch (err) {
                console.error('QR Image Generation Error:', err);
                return message.channel.send({
                    embeds: [SimpleEmbed(`❌ Failed to generate QR code image.`)]
                });
            }

            // Create attachment
            const qrAttachment = new AttachmentBuilder(qrImageBuffer, { name: 'payment_qr.png' });

            // Store pending transaction
            const transactionData = {
                oderId: transactionId,
                userId: user.id,
                amountUSD: amountUSD,
                goldAmount: goldAmount,
                md5: qrData.md5,
                qrString: qrData.qrString,
                createdAt: Date.now(),
                expiresAt: Date.now() + (15 * 60 * 1000), // 15 minutes expiry
                status: 'pending'
            };
            pendingTransactions.set(transactionId, transactionData);

            // Create buttons
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`check_payment_${transactionId}`)
                        .setLabel('✅ I have paid')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`cancel_payment_${transactionId}`)
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            // Create payment embed
            const paymentEmbed = customEmbed()
                .setColor('#E91E63')
                .setTitle('💳 Payment QR Code Generated')
                .setDescription(
                    `**Scan this QR code** with your banking app to pay.\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `${gif.gold_coin} **Gold:** \`${goldAmount.toLocaleString()}\` Gold\n` +
                    `💵 **Amount:** \`$${amountUSD.toFixed(2)}\` USD *(Auto-filled)*\n` +
                    `🆔 **Order:** \`${transactionId}\`\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `⏰ **Expires:** <t:${Math.floor(transactionData.expiresAt / 1000)}:R>\n\n` +
                    `**Instructions:**\n` +
                    `1️⃣ Open **Wing/Bakong/ABA** app\n` +
                    `2️⃣ Scan the QR code\n` +
                    `3️⃣ Amount **$${amountUSD.toFixed(2)}** is auto-filled!\n` +
                    `4️⃣ Confirm payment\n` +
                    `5️⃣ Click **"✅ I have paid"**`
                )
                .setImage('attachment://payment_qr.png')
                .setFooter({ text: `Pay to: ${BAKONG_CONFIG.accountNumber}` })
                .setTimestamp();

            const paymentMessage = await message.channel.send({
                embeds: [paymentEmbed],
                files: [qrAttachment],
                components: [row]
            });

            // Create button collector
            const collector = paymentMessage.createMessageComponentCollector({
                filter: (i) => i.user.id === user.id,
                time: 15 * 60 * 1000 // 15 minutes
            });

            collector.on('collect', async (interaction) => {
                try {
                    const transaction = pendingTransactions.get(transactionId);

                    if (!transaction) {
                        await interaction.reply({
                            content: '❌ Transaction not found or has expired.',
                            ephemeral: true
                        });
                        return;
                    }

                    // Handle "I have paid" - Verify via Bakong API
                    if (interaction.customId === `check_payment_${transactionId}`) {
                        await interaction.deferReply({ ephemeral: true });

                        // Check payment status via Bakong API
                        const paymentResult = await checkPaymentStatus(transaction.md5);

                        if (paymentResult.paid) {
                            // Payment confirmed! Add gold to user
                            const freshUserData = await getUser(user.id);
                            freshUserData.gold_coin = (freshUserData.gold_coin || 0) + transaction.goldAmount;
                            await freshUserData.save();

                            // Mark as completed
                            transaction.status = 'completed';
                            pendingTransactions.delete(transactionId);

                            // Update embed to show success
                            const successEmbed = customEmbed()
                                .setColor('#00FF00')
                                .setTitle('✅ Payment Successful!')
                                .setDescription(
                                    `🎉 **Thank you for your purchase!**\n\n` +
                                    `${gif.gold_coin} **Gold Received:** \`+${transaction.goldAmount.toLocaleString()}\` Gold\n` +
                                    `💰 **New Balance:** \`${freshUserData.gold_coin.toLocaleString()}\` Gold\n` +
                                    `💵 **Paid:** \`$${transaction.amountUSD.toFixed(2)}\` USD\n` +
                                    `🆔 **Order ID:** \`${transactionId}\`\n\n` +
                                    `Thank you for supporting **AceZero**! 💖`
                                )
                                .setTimestamp();

                            await paymentMessage.edit({
                                embeds: [successEmbed],
                                files: [],
                                components: []
                            });

                            await interaction.editReply({
                                content: `✅ **Payment Confirmed!**\n\nYou received ${gif.gold_coin} **${transaction.goldAmount.toLocaleString()} Gold**!`
                            });

                            // Log to admin channel
                            try {
                                const logChannel = await client.channels.fetch(GOLD_PURCHASE_LOG_CHANNEL_ID).catch(() => null);
                                if (logChannel) {
                                    const logEmbed = customEmbed()
                                        .setColor('#00FF00')
                                        .setTitle('💰 Gold Purchase Completed')
                                        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
                                        .addFields(
                                            { name: '👤 User', value: `${user.tag}\n\`${user.id}\``, inline: true },
                                            { name: '🏠 Server', value: `${message.guild?.name || 'DM'}\n\`${message.guild?.id || 'N/A'}\``, inline: true },
                                            { name: '💵 Paid', value: `**$${transaction.amountUSD.toFixed(2)}** USD`, inline: true },
                                            { name: `${gif.gold_coin} Gold`, value: `**+${transaction.goldAmount.toLocaleString()}**`, inline: true },
                                            { name: '💰 New Balance', value: `**${freshUserData.gold_coin.toLocaleString()}** Gold`, inline: true },
                                            { name: '🆔 Order ID', value: `\`${transactionId}\``, inline: true }
                                        )
                                        .setTimestamp();

                                    await logChannel.send({ embeds: [logEmbed] });
                                }
                            } catch (logError) {
                                console.error('Log channel error:', logError);
                            }

                            collector.stop('completed');
                        } else {
                            // Payment not found yet
                            await interaction.editReply({
                                content: `⏳ **Payment not detected yet.**\n\nPlease make sure you:\n• Completed the payment in your banking app\n• Paid exactly **$${transaction.amountUSD.toFixed(2)}**\n\nWait a few seconds and try again.`
                            });
                        }
                    }

                    // Handle Cancel
                    else if (interaction.customId === `cancel_payment_${transactionId}`) {
                        pendingTransactions.delete(transactionId);

                        const cancelEmbed = customEmbed()
                            .setColor('#FF0000')
                            .setTitle('❌ Payment Cancelled')
                            .setDescription(
                                `The payment has been cancelled.\n\n` +
                                `🆔 **Order ID:** \`${transactionId}\`\n\n` +
                                `Use \`Zbuygold <amount>\` to create a new order.`
                            )
                            .setTimestamp();

                        await paymentMessage.edit({
                            embeds: [cancelEmbed],
                            files: [],
                            components: []
                        });

                        await interaction.reply({
                            content: '✅ Payment cancelled.',
                            ephemeral: true
                        });

                        collector.stop('cancelled');
                    }
                } catch (err) {
                    console.error('Button Interaction Error:', err);
                }
            });

            collector.on('end', async (collected, reason) => {
                if (reason === 'time') {
                    const transaction = pendingTransactions.get(transactionId);
                    if (transaction && transaction.status === 'pending') {
                        pendingTransactions.delete(transactionId);

                        const expiredEmbed = customEmbed()
                            .setColor('#808080')
                            .setTitle('⏰ Payment Expired')
                            .setDescription(
                                `This payment has expired.\n\n` +
                                `🆔 **Order ID:** \`${transactionId}\`\n\n` +
                                `Use \`Zbuygold <amount>\` to create a new order.`
                            )
                            .setTimestamp();

                        await paymentMessage.edit({
                            embeds: [expiredEmbed],
                            files: [],
                            components: []
                        }).catch(() => { });
                    }
                }
            });

        } catch (error) {
            console.log(`buygold command error: ${error}`);
            message.channel.send({
                embeds: [SimpleEmbed(`❌ An error occurred: ${error.message}`)]
            }).catch(() => { });
        }
    }
};
