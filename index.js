const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// Configurações do Telegram
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const telegramAdminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || telegramChatId;
const bot = new TelegramBot(telegramToken, { polling: false });

// Configurações da Bitget
const bitgetApiKey = process.env.BITGET_API_KEY;
const bitgetApiSecret = process.env.BITGET_API_SECRET;
const bitgetApiPassphrase = process.env.BITGET_PASSPHRASE;
const bitgetApiUrl = 'https://api.bitget.com';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const generateSignature = (timestamp, method, requestPath, body = '') => {
    const message = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', bitgetApiSecret).update(message).digest('base64');
};

const bitgetRequest = async (method, requestPath, data = {}) => {
    const timestamp = Date.now().toString();
    const body = method === 'GET' ? '' : JSON.stringify(data);
    const signature = generateSignature(timestamp, method, requestPath, body);

    try {
        const headers = {
            'Content-Type': 'application/json',
            'ACCESS-KEY': bitgetApiKey,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-SIGN': signature,
            'ACCESS-PASSPHRASE': bitgetApiPassphrase,
            'locale': 'en-US'
        };

        const config = { method, url: `${bitgetApiUrl}${requestPath}`, headers };
        if (method !== 'GET') config.data = body;

        const response = await axios(config);
        return response.data;
    } catch (error) {
        const errorDetails = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
        throw new Error(errorDetails);
    }
};

// 1. LEITOR DE SALDO SIMPLIFICADO (Evita erro de assinatura da Bitget)
const getAvailableBalance = async () => {
    try {
        const resAll = await bitgetRequest('GET', '/api/v2/account/all-account-balance');
        if (resAll && resAll.data && Array.isArray(resAll.data)) {
            const futuresAcc = resAll.data.find(acc => acc.coin === 'USDT' && (acc.accountType === 'USDT-FUTURES' || acc.accountType === 'futures'));
            if (futuresAcc && futuresAcc.available !== undefined) {
                console.log(`[BOT] Saldo livre encontrado: ${futuresAcc.available} USDT`);
                return parseFloat(futuresAcc.available);
            }
        }
        return 0;
    } catch (error) {
        console.error('[BOT] Erro ao ler saldo:', error.message);
        return 0;
    }
};

// 2. Buscar posições abertas
const getOpenPositionData = async (symbol) => {
    try {
        const response = await bitgetRequest('GET', `/api/v2/mix/position/single-position?symbol=${symbol}&productType=USDT-FUTURES&marginCoin=USDT`);
        if (response && response.data && Array.isArray(response.data)) {
            const positions = response.data.filter(pos => pos.symbol === symbol && parseFloat(pos.total) > 0);
            if (positions.length > 0) return positions[0]; 
        }
        return null;
    } catch (error) {
        return null;
    }
};

// 3. Ajustar Alavancagem
const setLeverage = async (symbol, leverage, holdSide) => {
    try {
        let levData = { symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage: leverage.toString(), holdSide };
        try {
            await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', levData);
        } catch (e) {
            delete levData.holdSide; // Adaptação automática
            await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', levData);
        }
    } catch (error) {
        console.log(`[BOT] Aviso ao ajustar alavancagem: ${error.message}`);
    }
};

// 4. Fechamento forçado de posição com Adaptação
const closePosition = async (symbol, holdSide) => {
    try {
        let orderData = { symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', holdSide };
        try {
            await bitgetRequest('POST', '/api/v2/mix/order/close-positions', orderData);
        } catch (e) {
            delete orderData.holdSide; // Adaptação automática
            await bitgetRequest('POST', '/api/v2/mix/order/close-positions', orderData);
        }
        console.log(`[BOT] Posição de ${symbol} fechada com sucesso.`);
    } catch (error) {
        throw new Error(`Falha ao fechar posição: ${error.message}`);
    }
};

const placeOrder = async (symbol, action, price, stopLoss, takeProfit, slPct, tpPct) => {
    try {
        const side = action === 'buy' ? 'buy' : 'sell';
        const holdSide = action === 'buy' ? 'long' : 'short';

        let alavancagem = 10;
        if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE') || symbol.includes('ICP')) alavancagem = 5;
        await setLeverage(symbol, alavancagem, holdSide);

        await getAvailableBalance(); // Apenas imprime o saldo no terminal

        const marginToUse = 10; 
        let size = (marginToUse * alavancagem) / price;
        if (symbol.includes('BTC')) size = size.toFixed(3);
        else if (symbol.includes('ETH')) size = size.toFixed(2);
        else if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE')) size = Math.floor(size).toString();
        else size = size.toFixed(1);

        let orderData = {
            symbol: symbol,
            productType: 'USDT-FUTURES',
            marginMode: 'isolated',
            marginCoin: 'USDT',
            size: size.toString(),
            price: price.toString(),
            side: side,
            orderType: 'market',
            holdSide: holdSide
        };

        // Tenta abrir a ordem. Se a Bitget reclamar do modo de posição, adapta e tenta de novo.
        try {
            await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderData);
        } catch (e) {
            console.log(`[BOT] Adaptando modo de posição para ${symbol}...`);
            delete orderData.holdSide;
            await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderData);
        }

        await sleep(2000);

        let posTpslData = {
            symbol: symbol,
            productType: 'USDT-FUTURES',
            marginCoin: 'USDT',
            holdSide: holdSide,
            stopSurplusTriggerPrice: takeProfit.toString(),
            stopSurplusTriggerType: 'mark_price',
            stopLossTriggerPrice: stopLoss.toString(),
            stopLossTriggerType: 'mark_price'
        };

        try {
            await bitgetRequest('POST', '/api/v2/mix/order/place-pos-tpsl', posTpslData);
        } catch (e) {
            delete posTpslData.holdSide;
            await bitgetRequest('POST', '/api/v2/mix/order/place-pos-tpsl', posTpslData);
        }

    } catch (error) {
        throw error;
    }
};

const handleSignal = async (body) => {
    let normalizedSymbol = '';
    let signalDetails = ''; 
    try {
        const { action, symbol, price, stopLoss, takeProfit, slPct, tpPct, timeframe, wins, losses, winRate } = body;
        if (!action || !symbol || !price || !stopLoss || !takeProfit) return;

        normalizedSymbol = symbol.replace('_', '').toUpperCase();
        const tipo = action === 'buy' ? 'COMPRA (LONG)' : 'VENDA (SHORT)';
        const emoji = action === 'buy' ? '🟢' : '🔴';
        const bitgetLink = `https://www.bitget.com/pt-BR/mix/usdt/${normalizedSymbol}?type=futures`;

        let alavancagemTexto = '10x';
        if (normalizedSymbol.includes('XRP') || normalizedSymbol.includes('ADA') || normalizedSymbol.includes('DOGE') || normalizedSymbol.includes('ICP')) alavancagemTexto = '5x';

        signalDetails = `📌 *Par:* ${normalizedSymbol}\n⏱ *Timeframe:* ${timeframe}\n⚙️ *Alavancagem:* ${alavancagemTexto}\n\n💰 *Entrada:* \`${price}\`\n🎯 *Take Profit:* \`${takeProfit}\` (${tpPct > 0 ? '+' : ''}${tpPct}%)\n🛑 *Stop Loss:* \`${stopLoss}\` (${slPct > 0 ? '-' : ''}${slPct}%)\n📊 *Placar Geral:* ${wins}W - ${losses}L (${winRate}%)\n🔗 [Operar na Bitget: Clique aqui](${bitgetLink})\n`;

        const vipMsg = `${emoji} *SINAL DE ${tipo}*\n━━━━━━━━━━━━━━━━━━━━\n${signalDetails}━━━━━━━━━━━━━━━━━━━━\n_Sinal gerado por IA_`;
        await bot.sendMessage(telegramChatId, vipMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });

        const openPosition = await getOpenPositionData(normalizedSymbol);
        if (openPosition) {
            const currentHoldSide = openPosition.holdSide; 
            const newHoldSide = action === 'buy' ? 'long' : 'short';

            if (currentHoldSide === newHoldSide) {
                const adminMsg = `⚠️ *SINAL IGNORADO (POSIÇÃO DUPLICADA)*\n━━━━━━━━━━━━━━━━━━━━\n${signalDetails}━━━━━━━━━━━━━━━━━━━━\n_Motivo: Já existe operação na mesma direção._`;
                await bot.sendMessage(telegramAdminChatId, adminMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
                return; 
            } else {
                const adminMsgReversao = `🔄 *REVERSÃO DE TENDÊNCIA DETECTADA*\n━━━━━━━━━━━━━━━━━━━━\n📌 *Par:* ${normalizedSymbol}\n_Fechando posição anterior para abrir a nova..._`;
                await bot.sendMessage(telegramAdminChatId, adminMsgReversao, { parse_mode: 'Markdown', disable_web_page_preview: true });

                await closePosition(normalizedSymbol, currentHoldSide);
                await sleep(2000); 
            }
        }

        await placeOrder(normalizedSymbol, action, price, stopLoss, takeProfit, slPct, tpPct);

        if (await getOpenPositionData(normalizedSymbol)) { 
            const adminMsg = `✅ *ORDEM EXECUTADA COM SUCESSO*\n━━━━━━━━━━━━━━━━━━━━\n${signalDetails}━━━━━━━━━━━━━━━━━━━━\n_Status: Ordem automática protegida com TP/SL!_`;
            await bot.sendMessage(telegramAdminChatId, adminMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }
    } catch (error) {
        const fallbackDetails = signalDetails || `📌 *Par:* ${normalizedSymbol || 'Desconhecido'}\n`;
        const adminMsg = `❌ *ERRO AO EXECUTAR ORDEM*\n━━━━━━━━━━━━━━━━━━━━\n${fallbackDetails}━━━━━━━━━━━━━━━━━━━━\n_Motivo: ${error.message}_`;
        await bot.sendMessage(telegramAdminChatId, adminMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
    }
};

app.post('/webhook-bot', async (req, res) => {
    try {
        const body = req.body;

        if (body.action === 'close' || (body.result_icon && body.placar_str)) {
            if (body.symbol) {
                const normalizedSymbol = body.symbol.replace('_', '').toUpperCase();
                const openPosition = await getOpenPositionData(normalizedSymbol);
                if (openPosition) {
                    try {
                        await closePosition(normalizedSymbol, openPosition.holdSide);
                        console.log(`[BOT] Posição fechada via Webhook (Trailing Stop).`);
                    } catch (e) {
                        console.error('[BOT] Erro ao tentar fechar posição no webhook:', e.message);
                    }
                }
            }

            const exitMsg = body.result_icon + "\n" +
                            "━━━━━━━━━━━━━━━━━━━━\n" +
                            "📌 *Par:* "        + body.pair_name + "\n" +
                            "⏱ *Timeframe:* "  + body.timeframe + "\n" +
                            "🔄 *Operação:* "   + body.trade_dir + "\n" +
                            "💰 *Entrada:* `"   + body.entry_price + "`\n" +
                            "🏁 *Saída:* `"     + body.exit_price + "`\n" +
                            "💵 *Resultado:* "  + body.result_text + "\n" +
                            "━━━━━━━━━━━━━━━━━━━━" + body.placar_str;

            await bot.sendMessage(telegramChatId, exitMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
            await bot.sendMessage(telegramAdminChatId, exitMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });

        } else if (body.action === 'buy' || body.action === 'sell') {
            await handleSignal(body);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('[BOT] Erro no webhook:', error);
        res.status(500).send('Erro interno do servidor');
    }
});

app.get('/', (req, res) => { res.status(200).send('Bot de sinais está online!'); });
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Servidor na porta ${PORT}`); });