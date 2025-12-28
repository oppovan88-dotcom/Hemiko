const { getUser, SimpleEmbed, gif, cooldown, customEmbed } = require('../../functioon/function');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { BakongKHQR, khqrData, IndividualInfo } = require('bakong-khqr');
const { createCanvas } = require('canvas');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const cooldowns = new Map();
let CDT = 15_000; // 15 second cooldown
var getId = [];
var cdId = [];
var prem = [];

// ======================== BAKONG WING CONFIGURATION (from .env) ========================
const BAKONG_CONFIG = {
    // Wing Bank Account Details (from .env)
    accountNumber: process.env.BAKONG_ACCOUNT_NUMBER || '+855 93 366 631',
    merchantName: process.env.BAKONG_MERCHANT_NAME || 'AceZero Gold Shop',
    merchantCity: process.env.BAKONG_MERCHANT_CITY || 'Phnom Penh',

    // API Token for transaction verification (from .env)
    apiToken: process.env.BAKONG_API_TOKEN || '',

    // API Base URL
    apiBaseUrl: 'https://api-bakong.nbc.gov.kh',

    // Exchange Rate: Gold per 1 USD (from .env)
    goldPerUSD: parseInt(process.env.BAKONG_GOLD_PER_USD) || 100,

    // Minimum and Maximum purchase amounts (from .env)
    minUSD: parseInt(process.env.BAKONG_MIN_USD) || 1,
    maxUSD: parseInt(process.env.BAKONG_MAX_USD) || 100
};

// ======================== QR CODE GENERATION ========================
/**
 * Generate KHQR code data for payment
 * @param {number} amountUSD - Amount in USD (for reference, not embedded in static QR)
 * @param {string} transactionId - Unique transaction reference
 * @returns {object} - QR code data
 */
function generateKHQRData(amountUSD, transactionId) {
    try {
        // Create Individual Info for KHQR
        // Note: bakongAccountID should be in format: username@bankname (e.g., sovan_narith@wing)
        // Using static QR (no amount) - user will enter amount manually when scanning
        const individualInfo = {
            bakongAccountID: BAKONG_CONFIG.accountNumber, // Should be like: sovan_narith@wing
            merchantName: BAKONG_CONFIG.merchantName,
            merchantCity: BAKONG_CONFIG.merchantCity,
            currency: khqrData.currency.usd,
            // Note: Not including amount to create static QR - amount shown in message
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
            amountUSD: amountUSD // Store amount for reference
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
 * Generate QR Code image from text using canvas
 * @param {string} text - QR code content
 * @returns {Buffer} - PNG image buffer
 */
async function generateQRImage(text) {
    try {
        // Use a simple text-based QR approach or external library
        // For now, we'll create a simple canvas with the QR string
        // In production, you might want to use a library like 'qrcode'

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
    } catch (error) {
        // Fallback: Create a simple canvas with instructions
        const canvas = createCanvas(400, 400);
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, 400, 400);

        // Border
        ctx.strokeStyle = '#E91E63';
        ctx.lineWidth = 4;
        ctx.strokeRect(10, 10, 380, 380);

        // Text
        ctx.fillStyle = '#333333';
        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Scan with Bakong/Wing App', 200, 40);

        ctx.font = '12px Arial';
        ctx.fillText('QR Code Data:', 200, 80);

        // Wrap text
        const words = text.split('');
        let line = '';
        let y = 110;
        for (let i = 0; i < Math.min(words.length, 500); i++) {
            line += words[i];
            if (line.length >= 40) {
                ctx.fillText(line, 200, y);
                line = '';
                y += 18;
            }
        }
        if (line) {
            ctx.fillText(line, 200, y);
        }

        return canvas.toBuffer('image/png');
    }
}

/**
 * Check transaction status via Bakong API
 * @param {string} md5 - MD5 hash of QR code
 * @returns {object} - Transaction status
 */
async function checkTransactionStatus(md5) {
    try {
        const response = await axios.post(
            `${BAKONG_CONFIG.apiBaseUrl}/v1/check_transaction_by_md5`,
            { md5: md5 },
            {
                headers: {
                    'Authorization': `Bearer ${BAKONG_CONFIG.apiToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        return {
            success: true,
            data: response.data
        };
    } catch (error) {
        console.error('Transaction Check Error:', error.response?.data || error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// ======================== PENDING TRANSACTIONS STORE ========================
// In production, use a database. This is a simple in-memory store.
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
                        `**Usage:** \`hm buygold <amount_usd>\`\n\n` +
                        `**Examples:**\n` +
                        `• \`hm buygold 1\` → Buy ${gif.gold_coin} **100 Gold** for **$1**\n` +
                        `• \`hm buygold 5\` → Buy ${gif.gold_coin} **500 Gold** for **$5**\n` +
                        `• \`hm buygold 10\` → Buy ${gif.gold_coin} **1,000 Gold** for **$10**\n\n` +
                        `**Limits:**\n` +
                        `• Minimum: **$${BAKONG_CONFIG.minUSD}** (${BAKONG_CONFIG.minUSD * BAKONG_CONFIG.goldPerUSD} Gold)\n` +
                        `• Maximum: **$${BAKONG_CONFIG.maxUSD}** (${BAKONG_CONFIG.maxUSD * BAKONG_CONFIG.goldPerUSD} Gold)\n\n` +
                        `**Payment Methods:**\n` +
                        `• 📱 **Wing App** (Scan QR)\n` +
                        `• 🏦 **Bakong App** (Scan QR)\n` +
                        `• 🏧 **Any KHQR-enabled bank**`
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
            const transactionId = `YN-${user.id.slice(-6)}-${Date.now().toString(36).toUpperCase()}`;

            // Generate KHQR
            const qrData = generateKHQRData(amountUSD, transactionId);

            if (!qrData.success) {
                return message.channel.send({
                    embeds: [SimpleEmbed(`❌ Failed to generate payment QR code. Please try again later.\n\nError: ${qrData.error}`)]
                });
            }

            // Generate QR Code Image
            let qrImageBuffer;
            try {
                qrImageBuffer = await generateQRImage(qrData.qrString);
            } catch (err) {
                console.error('QR Image Generation Error:', err);
                return message.channel.send({
                    embeds: [SimpleEmbed(`❌ Failed to generate QR code image. Please install the 'qrcode' package:\n\`npm install qrcode\``)]
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
                        .setLabel('✅ Check Payment')
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
                    `**Scan this QR code** with your **Wing** or **Bakong** app to complete the payment.\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `${gif.gold_coin} **Gold Amount:** \`${goldAmount.toLocaleString()}\` Gold\n` +
                    `💵 **Price:** \`$${amountUSD.toFixed(2)}\` USD\n` +
                    `🆔 **Order ID:** \`${transactionId}\`\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `⏰ **Expires in:** <t:${Math.floor(transactionData.expiresAt / 1000)}:R>\n\n` +
                    `**Instructions:**\n` +
                    `1️⃣ Open **Wing** or **Bakong** app\n` +
                    `2️⃣ Scan the QR code above\n` +
                    `3️⃣ Confirm payment of **$${amountUSD.toFixed(2)}**\n` +
                    `4️⃣ Click **"✅ Check Payment"** button\n\n` +
                    `⚠️ **Note:** Payment must match exact amount!`
                )
                .setImage('attachment://payment_qr.png')
                .setFooter({ text: `Recipient: ${BAKONG_CONFIG.accountNumber} (Wing USD)` })
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

                    // Handle Check Payment
                    if (interaction.customId === `check_payment_${transactionId}`) {
                        await interaction.deferReply({ ephemeral: true });

                        // Check if expired
                        if (Date.now() > transaction.expiresAt) {
                            pendingTransactions.delete(transactionId);
                            await interaction.editReply({
                                content: '❌ This payment has expired. Please create a new order with `hm buygold <amount>`.'
                            });
                            collector.stop();
                            return;
                        }

                        // Check transaction status via Bakong API
                        const statusResult = await checkTransactionStatus(transaction.md5);

                        if (statusResult.success && statusResult.data?.responseCode === 0) {
                            // Payment successful!
                            const freshUserData = await getUser(user.id);
                            freshUserData.gold_coin = (freshUserData.gold_coin || 0) + transaction.goldAmount;
                            await freshUserData.save();

                            // Mark as completed
                            transaction.status = 'completed';
                            pendingTransactions.delete(transactionId);

                            // Update embed
                            const successEmbed = customEmbed()
                                .setColor('#00FF00')
                                .setTitle('✅ Payment Successful!')
                                .setDescription(
                                    `🎉 **Thank you for your purchase!**\n\n` +
                                    `${gif.gold_coin} **Gold Received:** \`+${transaction.goldAmount.toLocaleString()}\` Gold\n` +
                                    `💰 **New Balance:** \`${freshUserData.gold_coin.toLocaleString()}\` Gold\n` +
                                    `💵 **Paid:** \`$${transaction.amountUSD.toFixed(2)}\` USD\n` +
                                    `🆔 **Order ID:** \`${transactionId}\`\n\n` +
                                    `Thank you for supporting **Yukio Nori Bot**! 💖`
                                )
                                .setTimestamp();

                            await paymentMessage.edit({
                                embeds: [successEmbed],
                                files: [],
                                components: []
                            });

                            await interaction.editReply({
                                content: `✅ Payment confirmed! You received ${gif.gold_coin} **${transaction.goldAmount.toLocaleString()} Gold**!`
                            });

                            collector.stop('completed');
                        } else {
                            // Payment not found yet
                            await interaction.editReply({
                                content: `⏳ **Payment not detected yet.**\n\nPlease make sure you:\n• Scanned the QR code correctly\n• Paid exactly **$${transaction.amountUSD.toFixed(2)}**\n• Used Wing or Bakong app\n\nTry again in a few seconds after completing payment.`
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
                                `Use \`hm buygold <amount>\` to create a new order.`
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
                    await interaction.reply({
                        content: '❌ An error occurred. Please try again.',
                        ephemeral: true
                    }).catch(() => { });
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
                                `Use \`hm buygold <amount>\` to create a new order.`
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
