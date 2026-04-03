const axios  = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://api.bitget.com';

function sign(timestamp, method, requestPath, body, secret) {
    const message = timestamp + method.toUpperCase() + requestPath + (body || '');
    return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

function toSymbol(symbol) {
    // converte BTC_USDT → BTCUSDT_UMCBL
    return symbol.replace('_', '') + '_UMCBL';
}

async function request(method, path, params = {}) {
    const apiKey      = process.env.BITGET_API_KEY;
    const apiSecret   = process.env.BITGET_API_SECRET;
    const passphrase  = process.env.BITGET_PASSPHRASE;
    const timestamp   = Date.now().toString();

    let requestPath = path;
    let body = '';

    if (method === 'GET' && Object.keys(params).length > 0) {
        const qs = new URLSearchParams(params).toString();
        requestPath = path + '?' + qs;
    } else if (method === 'POST') {
        body = JSON.stringify(params);
    }

    const signature = sign(timestamp, method, requestPath, body, apiSecret);

    const config = {
        method,
        url: BASE_URL + requestPath,
        headers: {
            'ACCESS-KEY':        apiKey,
            'ACCESS-SIGN':       signature,
            'ACCESS-TIMESTAMP':  timestamp,
            'ACCESS-PASSPHRASE': passphrase,
            'Content-Type':      'application/json',
            'locale':            'en-US'
        }
    };

    if (method === 'POST') {
        config.data = body;
    }

    try {
        const res = await axios(config);
        return res.data;
    } catch (err) {
        const detail = err.response?.data || err.message;
        console.error('[BOT] Erro na requisição:', JSON.stringify(detail));
        throw new Error(JSON.stringify(detail));
    }
}

async function setLeverage(symbol, leverage, holdSide) {
    return request('POST', '/api/mix/v1/account/setLeverage', {
        symbol,
        marginCoin: 'USDT',
        leverage:   String(leverage),
        holdSide
    });
}

async function getBalance() {
    try {
        const res = await request('GET', '/api/mix/v1/account/accounts', { productType: 'umcbl' });
        const usdt = res.data?.find(a => a.marginCoin === 'USDT');
        console.log('[BOT] Saldo encontrado:', usdt);
        return usdt ? parseFloat(usdt.available) : 0;
    } catch (err) {
        console.error('[BOT] Erro ao buscar saldo:', err.message);
        return 0;
    }
}

async function getOpenPositions() {
    try {
        const res = await request('GET', '/api/mix/v1/position/allPosition', { productType: 'umcbl' });
        return res.data || [];
    } catch (err) {
        console.error('[BOT] Erro ao buscar posições:', err.message);
        return [];
    }
}

async function placeOrder({ symbol, side, price, stopLoss, takeProfit }) {
    const leverage   = parseInt(process.env.LEVERAGE) || 5;
    const capital    = parseFloat(process.env.CAPITAL_PER_TRADE) || 10;
    const holdSide   = side === 'open_long' ? 'long' : 'short';

    await setLeverage(symbol, leverage, holdSide);

    const balance  = await getBalance();
    const useUSDT  = (balance * capital) / 100;
    const size     = ((useUSDT * leverage) / price).toFixed(4);

    console.log(`[BOT] Saldo: ${balance} USDT | Margem: ${useUSDT} | Size: ${size}`);

    if (parseFloat(size) <= 0) throw new Error(`Size inválido — saldo: ${balance} USDT`);

    return request('POST', '/api/mix/v1/order/placeOrder', {
        symbol,
        marginCoin:             'USDT',
        size,
        side,
        orderType:              'market',
        presetTakeProfitPrice:  String(takeProfit),
        presetStopLossPrice:    String(stopLoss),
        leverage:               String(leverage)
    });
}

var state = { active: false, symbol: null, side: null };

function getState() { return state; }

async function handleSignal(body) {
    const { action, symbol, price, stopLoss, takeProfit } = body;

    if (!symbol || !price) return { status: 'rejected', reason: 'dados incompletos' };

    const bgSymbol = toSymbol(symbol);

    if (action === 'buy' || action === 'sell') {
        if (state.active) return { status: 'skipped', reason: 'já há posição aberta' };

        const side = action === 'buy' ? 'open_long' : 'open_short';
        const res  = await placeOrder({ symbol: bgSymbol, side, price, stopLoss, takeProfit });

        console.log('[BOT] Resposta Bitget:', JSON.stringify(res));

        if (res.code === '00000') {
            state = { active: true, symbol: bgSymbol, side: action };
            return { status: 'ok', order: res.data };
        }
        return { status: 'error', detail: res };
    }

    if (action === 'close') {
        state = { active: false, symbol: null, side: null };
        return { status: 'closed' };
    }

    return { status: 'unknown_action' };
}

module.exports = { handleSignal, getState, getOpenPositions, getBalance };