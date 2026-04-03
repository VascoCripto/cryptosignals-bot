const crypto = require('crypto');
const https  = require('https');

const BASE_URL = 'api.bitget.com';

let botState = 'idle';

function getState() {
    return botState;
}

function sign(timestamp, method, path, body) {
    const message = timestamp + method.toUpperCase() + path + (body ? JSON.stringify(body) : '');
    return crypto.createHmac('sha256', process.env.BITGET_API_SECRET).update(message).digest('base64');
}

function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
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

        const payload = body ? JSON.stringify(body) : null;
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

        const options = { hostname: BASE_URL, path, method, headers };

        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    console.log('[BOT] Resposta API:', JSON.stringify(parsed));
                    resolve(parsed);
                } catch (e) {
                    reject(new Error('Resposta inválida: ' + data));
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function getOpenPositions() {
    const res = await request('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
    const positions = res.data ?? [];
    return positions.filter(p => parseFloat(p.total) > 0);
}

async function hasOpenPosition() {
    const open = await getOpenPositions();
    console.log('[BOT] Posições abertas:', open.length);
    return open.length > 0;
}

async function getBalance() {
    const res = await request('GET', '/api/v2/mix/account/account?symbol=BTCUSDT&productType=USDT-FUTURES&marginCoin=USDT');
    console.log('[BOT] Saldo bruto:', JSON.stringify(res));
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

    if (order.data) {
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
        // Validação dos campos obrigatórios
        if (!action || !symbol || !price) {
            console.log('[BOT] Payload inválido, campos faltando:', { action, symbol, price });
            return { status: 'ignorado', reason: 'payload inválido' };
        }

        botState = 'checking';
        const posicaoAberta = await hasOpenPosition();
        if (posicaoAberta) {
            console.log('[BOT] Já existe uma posição aberta. Sinal ignorado.');
            botState = 'idle';
            return { status: 'ignorado', reason: 'posição já aberta' };
        }

        botState = 'trading';
        const normalizedSymbol = symbol.replace('_', '').toUpperCase();
        const side   = action === 'buy' ? 'buy' : 'sell';
        const result = await placeOrder({
            symbol: normalizedSymbol,
            side,
            price:       parseFloat(price),
            stopLoss:    parseFloat(stopLoss),
            takeProfit:  parseFloat(takeProfit)
        });

        botState = 'idle';
        return { status: 'ok', data: result };
    } catch (err) {
        botState = 'idle';
        console.log('[BOT] Erro inesperado:', err.message);
        return { status: 'error', reason: err.message };
    }
}

module.exports = { handleSignal, getState, getOpenPositions, getBalance };