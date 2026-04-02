const axios  = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://contract.mexc.com';

function sign(apiKey, timestamp, paramsStr, secret) {
    const signStr = apiKey + timestamp + paramsStr;
    return crypto.createHmac('sha256', secret).update(signStr).digest('hex');
}

async function request(method, path, params = {}) {
    const apiKey    = process.env.MEXC_API_KEY;
    const apiSecret = process.env.MEXC_API_SECRET;
    const timestamp = Date.now().toString();

    let paramsStr = '';
    if (method === 'GET') {
        paramsStr = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    } else {
        paramsStr = JSON.stringify(params);
    }

    const signature = sign(apiKey, timestamp, paramsStr, apiSecret);

    const config = {
        method,
        url: BASE_URL + path,
        headers: {
            'ApiKey':       apiKey,
            'Request-Time': timestamp,
            'Signature':    signature,
            'Content-Type': 'application/json'
        }
    };

    if (method === 'GET') {
        config.params = params;
    } else {
        config.data = params;
    }

    const res = await axios(config);
    return res.data;
}

async function getContractDetail(symbol) {
    try {
        const res = await axios.get(`${BASE_URL}/api/v1/contract/detail`, { params: { symbol } });
        return res.data?.data || null;
    } catch (err) {
        console.error('[BOT] Erro ao buscar detalhes do contrato:', err.message);
        return null;
    }
}

async function setLeverage(symbol, leverage) {
    return request('POST', '/api/v1/private/position/change_leverage', {
        symbol,
        leverage,
        openType: 1
    });
}

async function getBalance() {
    try {
        const res = await request('GET', '/api/v1/private/account/assets', {});
        const usdt = res.data?.find(a => a.currency === 'USDT');
        console.log('[BOT] Saldo encontrado:', usdt);
        return usdt ? parseFloat(usdt.availableBalance) : 0;
    } catch (err) {
        console.error('[BOT] Erro ao buscar saldo:', err.message);
        return 0;
    }
}

async function getOpenPositions() {
    try {
        const res = await request('GET', '/api/v1/private/position/open_positions', {});
        return res.data || [];
    } catch (err) {
        console.error('[BOT] Erro ao buscar posições:', err.message);
        return [];
    }
}

async function placeOrder({ symbol, side, price, stopLoss, takeProfit }) {
    const leverage = parseInt(process.env.LEVERAGE) || 5;
    const capital  = parseFloat(process.env.CAPITAL_PER_TRADE) || 10;

    await setLeverage(symbol, leverage);

    const balance = await getBalance();
    const detail  = await getContractDetail(symbol);
    const contractSize  = detail?.contractSize || 0.0001;
    const contractValue = price * contractSize;

    const useUSDT = (balance * capital) / 100;
    const vol     = Math.floor((useUSDT * leverage) / contractValue);

    console.log(`[BOT] Saldo: ${balance} USDT | Margem: ${useUSDT} | ContractSize: ${contractSize} | Vol: ${vol}`);

    if (vol < 1) throw new Error(`Volume menor que 1 — saldo: ${balance} USDT, valor/contrato: ${contractValue} USDT`);

    return request('POST', '/api/v1/private/order/submit', {
        symbol,
        side,
        orderType:       5,
        openType:        1,
        vol,
        leverage,
        stopLossPrice:   stopLoss,
        takeProfitPrice: takeProfit
    });
}

var state = { active: false, symbol: null, side: null };

function getState() { return state; }

async function handleSignal(body) {
    const { action, symbol, price, stopLoss, takeProfit } = body;

    if (!symbol || !price) return { status: 'rejected', reason: 'dados incompletos' };

    if (action === 'buy' || action === 'sell') {
        if (state.active) return { status: 'skipped', reason: 'já há posição aberta' };

        const side = action === 'buy' ? 1 : 2;
        const res  = await placeOrder({ symbol, side, price, stopLoss, takeProfit });

        if (res.success) {
            state = { active: true, symbol, side: action };
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