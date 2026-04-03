const crypto = require('crypto');
const fetch  = require('node-fetch');

const BASE_URL = 'https://api.bitget.com';

function sign(timestamp, method, path, body) {
    const message = timestamp + method.toUpperCase() + path + (body ? JSON.stringify(body) : '');
    return crypto.createHmac('sha256', process.env.BITGET_SECRET).update(message).digest('base64');
}

async function request(method, path, body = null) {
    const timestamp = Date.now().toString();
    const signature = sign(timestamp, method, path, body);

    const headers = {
        'Content-Type':      'application/json',
        'ACCESS-KEY':        process.env.BITGET_API_KEY,
        'ACCESS-SIGN':       signature,
        'ACCESS-TIMESTAMP':  timestamp,
        'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE,
        'locale':            'en-US'
    };

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const res  = await fetch(BASE_URL + path, options);
    const data = await res.json();

    if (data.code && data.code !== '00000') {
        console.log('[BOT] Erro na requisição:', JSON.stringify(data));
        throw new Error(JSON.stringify(data));
    }

    return data;
}

async function getBalance() {
    const res = await request('GET', '/api/v2/mix/account/account?symbol=BTCUSDT&productType=USDT-FUTURES&marginCoin=USDT');
    console.log('[BOT] Resposta saldo:', JSON.stringify(res.data));
    return parseFloat(res.data?.available ?? 0);
}

async function setLeverage(symbol, leverage, holdSide) {
    await request('POST', '/api/v2/mix/account/set-leverage', {
        symbol,
        productType: 'USDT-FUTURES',
        marginCoin:  'USDT',
        leverage:    String(leverage),
        holdSide
    });
}

async function placeOrder({ symbol, side, price, stopLoss, takeProfit }) {
    const leverage = parseInt(process.env.LEVERAGE) || 5;
    const capital  = parseFloat(process.env.CAPITAL_PER_TRADE) || 10;
    const holdSide = side === 'buy' ? 'long' : 'short';

    await setLeverage(symbol, leverage, holdSide);

    const balance = await getBalance();
    const useUSDT = (balance * capital) / 100;
    const size    = ((useUSDT * leverage) / price).toFixed(4);

    console.log(`[BOT] Saldo: ${balance} USDT | Margem: ${useUSDT} | Size: ${size}`);

    if (parseFloat(size) <= 0) throw new Error(`Size inválido — saldo: ${balance} USDT`);

    const order = await request('POST', '/api/v2/mix/order/place-order', {
        symbol,
        productType: 'USDT-FUTURES',
        marginMode:  'isolated',
        marginCoin:  'USDT',
        size,
        side,
        tradeSide:   'open',
        orderType:   'market'
    });

    console.log('[BOT] Ordem enviada:', JSON.stringify(order));

    if (order.code === '00000' || order.data) {
        try {
            await request('POST', '/api/v2/mix/order/place-tpsl-order', {
                symbol,
                productType:  'USDT-FUTURES',
                marginCoin:   'USDT',
                planType:     'loss_plan',
                triggerPrice: String(stopLoss),
                triggerType:  'mark_price',
                executePrice: '0',
                holdSide,
                size
            });
            console.log('[BOT] Stop Loss configurado:', stopLoss);
        } catch (e) {
            console.log('[BOT] Erro ao configurar Stop Loss:', e.message);
        }

        try {
            await request('POST', '/api/v2/mix/order/place-tpsl-order', {
                symbol,
                productType:  'USDT-FUTURES',
                marginCoin:   'USDT',
                planType:     'profit_plan',
                triggerPrice: String(takeProfit),
                triggerType:  'mark_price',
                executePrice: '0',
                holdSide,
                size
            });
            console.log('[BOT] Take Profit configurado:', takeProfit);
        } catch (e) {
            console.log('[BOT] Erro ao configurar Take Profit:', e.message);
        }
    }

    return order;
}

async function handleSignal({ action, symbol, price, stopLoss, takeProfit }) {
    try {
        const side = action === 'buy' ? 'buy' : 'sell';
        const result = await placeOrder({ symbol, side, price, stopLoss, takeProfit });
        return { status: 'ok', data: result };
    } catch (err) {
        console.log('[BOT] Erro inesperado:', err.message);
        return { status: 'error', reason: err.message };
    }
}

module.exports = { handleSignal };