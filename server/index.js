/**
 * Backend Payment Server for Bakong/KHQR Payment Verification
 * This server handles payment verification with proper headers to avoid CloudFront blocking
 * 
 * Deploy to Render.com as a Web Service
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

// Load .env from server folder first, then fallback to parent folder
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.BAKONG_API_TOKEN) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const app = express();
// Render automatically sets PORT, fallback to PAYMENT_SERVER_PORT or 3001
const PORT = process.env.PORT || process.env.PAYMENT_SERVER_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// ======================== BAKONG CONFIGURATION ========================
const BAKONG_CONFIG = {
    accountNumber: process.env.BAKONG_ACCOUNT_NUMBER || 'sovan_narith@wing',
    merchantName: process.env.BAKONG_MERCHANT_NAME || 'AceZero Gold Shop',
    merchantCity: process.env.BAKONG_MERCHANT_CITY || 'Phnom Penh',
    apiToken: process.env.BAKONG_API_TOKEN || '',
    goldPerUSD: parseInt(process.env.BAKONG_GOLD_PER_USD) || 100,
    minUSD: parseInt(process.env.BAKONG_MIN_USD) || 1,
    maxUSD: parseInt(process.env.BAKONG_MAX_USD) || 100
};

// Transaction storage
const pendingTransactions = new Map();

// ======================== BROWSER-LIKE HEADERS TO BYPASS CLOUDFRONT ========================
const getBrowserHeaders = () => ({
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,km;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Content-Type': 'application/json',
    'Origin': 'https://bakong.nbc.gov.kh',
    'Referer': 'https://bakong.nbc.gov.kh/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'Authorization': `Bearer ${BAKONG_CONFIG.apiToken}`
});

// ======================== API ROUTES ========================

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        bakongConfigured: !!BAKONG_CONFIG.apiToken
    });
});

// Get config
app.get('/api/config', (req, res) => {
    res.json({
        goldPerUSD: BAKONG_CONFIG.goldPerUSD,
        minUSD: BAKONG_CONFIG.minUSD,
        maxUSD: BAKONG_CONFIG.maxUSD,
        merchantName: BAKONG_CONFIG.merchantName
    });
});

// Store transaction
app.post('/api/transactions', (req, res) => {
    try {
        const { transactionId, userId, amountUSD, goldAmount, md5, qrString, expiresAt } = req.body;

        if (!transactionId || !userId || !amountUSD || !goldAmount || !md5) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        const transactionData = {
            transactionId,
            userId,
            amountUSD,
            goldAmount,
            md5,
            qrString,
            createdAt: Date.now(),
            expiresAt: expiresAt || Date.now() + (15 * 60 * 1000),
            status: 'pending',
            lastChecked: null
        };

        pendingTransactions.set(transactionId, transactionData);
        console.log(`[Payment Server] Transaction created: ${transactionId}`);

        res.json({ success: true, transactionId, expiresAt: transactionData.expiresAt });
    } catch (error) {
        console.error('[Payment Server] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get transaction
app.get('/api/transactions/:transactionId', (req, res) => {
    const transaction = pendingTransactions.get(req.params.transactionId);
    if (!transaction) {
        return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    res.json({ success: true, transaction });
});

/**
 * CHECK PAYMENT STATUS - Main endpoint that calls Bakong API
 * Uses browser-like headers to avoid CloudFront 403 blocking
 */
app.post('/api/check-payment', async (req, res) => {
    try {
        let { transactionId, md5 } = req.body;

        // Get md5 from transaction if only transactionId provided
        if (transactionId && !md5) {
            const transaction = pendingTransactions.get(transactionId);
            if (!transaction) {
                return res.status(404).json({ success: false, paid: false, error: 'Transaction not found' });
            }
            md5 = transaction.md5;
        }

        if (!md5) {
            return res.status(400).json({ success: false, paid: false, error: 'MD5 hash required' });
        }

        console.log(`[Payment Server] Checking payment for MD5: ${md5}`);

        // Call Bakong API with browser-like headers
        const response = await axios.post(
            'https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5',
            { md5: md5 },
            {
                headers: getBrowserHeaders(),
                timeout: 20000,
                validateStatus: (status) => status < 500 // Accept non-5xx responses
            }
        );

        console.log(`[Payment Server] Bakong Response Status: ${response.status}`);
        console.log(`[Payment Server] Bakong Response:`, JSON.stringify(response.data));

        let paid = false;
        if (response.data) {
            if (response.data.responseCode === 0 || (response.data.data && response.data.data.length > 0)) {
                paid = true;
                console.log(`[Payment Server] ✅ Payment CONFIRMED!`);

                // Update transaction status
                if (transactionId) {
                    const tx = pendingTransactions.get(transactionId);
                    if (tx) {
                        tx.status = 'completed';
                        tx.completedAt = Date.now();
                    }
                }
            }
        }

        // Update last checked
        if (transactionId) {
            const tx = pendingTransactions.get(transactionId);
            if (tx) tx.lastChecked = Date.now();
        }

        res.json({ success: true, paid, data: response.data, transactionId, md5 });

    } catch (error) {
        console.error('[Payment Server] Check payment error:', error.response?.status, error.response?.data || error.message);

        // Return detailed error for debugging
        res.status(500).json({
            success: false,
            paid: false,
            error: error.message,
            status: error.response?.status,
            details: typeof error.response?.data === 'string'
                ? error.response.data.substring(0, 200)
                : error.response?.data
        });
    }
});

// Generate deeplink with browser headers
app.post('/api/generate-deeplink', async (req, res) => {
    try {
        const { qrString, appIconUrl, appName } = req.body;

        if (!qrString) {
            return res.status(400).json({ success: false, error: 'QR string required' });
        }

        console.log(`[Payment Server] Generating deeplink...`);

        const response = await axios.post(
            'https://api-bakong.nbc.gov.kh/v1/generate_deeplink_by_qr',
            {
                qr: qrString,
                sourceInfo: {
                    appIconUrl: appIconUrl || 'https://cdn.discordapp.com/embed/avatars/0.png',
                    appName: appName || 'Yukio Bot',
                    appDeepLinkCallback: ''
                }
            },
            {
                headers: getBrowserHeaders(),
                timeout: 15000
            }
        );

        const shortLink = response.data?.data?.shortLink;
        console.log(`[Payment Server] Deeplink generated: ${shortLink}`);

        res.json({ success: true, shortLink });

    } catch (error) {
        console.error('[Payment Server] Deeplink error:', error.response?.status, error.message);
        res.json({ success: false, shortLink: null, error: error.message });
    }
});

// Delete transaction
app.delete('/api/transactions/:transactionId', (req, res) => {
    const existed = pendingTransactions.delete(req.params.transactionId);
    res.json({ success: true, deleted: existed });
});

// Complete transaction
app.post('/api/transactions/:transactionId/complete', (req, res) => {
    const tx = pendingTransactions.get(req.params.transactionId);
    if (!tx) {
        return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    tx.status = 'completed';
    tx.completedAt = Date.now();
    setTimeout(() => pendingTransactions.delete(req.params.transactionId), 60000);
    res.json({ success: true });
});

// List all transactions (admin)
app.get('/api/transactions', (req, res) => {
    const list = [];
    pendingTransactions.forEach((tx, id) => list.push({ ...tx, transactionId: id }));
    res.json({ success: true, count: list.length, transactions: list });
});

// Cleanup expired transactions
setInterval(() => {
    const now = Date.now();
    pendingTransactions.forEach((tx, id) => {
        if (tx.status === 'pending' && tx.expiresAt < now) {
            pendingTransactions.delete(id);
            console.log(`[Payment Server] Expired: ${id}`);
        }
    });
}, 60000);

// Start server - bind to 0.0.0.0 for Render deployment
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║              💰 BAKONG PAYMENT SERVER STARTED 💰               ║
╠════════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                   ║
║  Bakong Token: ${BAKONG_CONFIG.apiToken ? '✅ Configured' : '❌ Missing'}                               ║
║  Time: ${new Date().toISOString()}                 ║
╠════════════════════════════════════════════════════════════════╣
║  Endpoints:                                                    ║
║  • POST /api/check-payment     - Check payment (main)          ║
║  • POST /api/generate-deeplink - Generate mobile deeplink      ║
║  • POST /api/transactions      - Create transaction            ║
║  • GET  /api/transactions/:id  - Get transaction               ║
╚════════════════════════════════════════════════════════════════╝
`);
});

module.exports = app;
