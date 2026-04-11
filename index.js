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
const telegramChatId = process.env.TELEGRAM_CHAT_ID; // GRUPO VIP
const telegramAdminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || telegramChatId; // GRUPO ADMIN
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
        console.error('[BOT] Erro na requisição Bitget API:', errorDetails);
        throw new Error(errorDetails);
    }
};

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

const closePosition = async (symbol, holdSide) => {
    try {
        // Usando o endpoint oficial de fechamento forçado (ignora TP/SL pendentes)
        const orderData = {
            symbol: symbol,
            productType: 'USDT-FUTURES',
            marginCoin: 'USDT',
            holdSide: holdSide
        };
        await bitgetRequest('POST', '/api/v2/mix/order/close-positions', orderData);
        console.log(`[BOT] Posição ${holdSide} de ${symbol} fechada com sucesso.`);
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

        const availableBalance = await getAvailableBalance();
        const marginToUse = 10; 

        if (availableBalance < marginToUse) throw new Error(`Saldo insuficiente. Saldo livre atual: ${availableBalance}`);

        let size = (marginToUse * alavancagem) / price;
        if (symbol.includes('BTC')) size = size.toFixed(3);
        else if (symbol.includes('ETH')) size = size.toFixed(2);
        else if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE')) size = Math.floor(size).toString();
        else if (symbol.includes('ICP')) size = size.toFixed(2);
        else if (symbol.includes('AVAX') || symbol.includes('DOT') || symbol.includes('SOL') || symbol.includes('BNB') || symbol.includes('ZEC')) size = size.toFixed(1);
        else if (symbol.includes('BGB')) size = Math.floor(size).toString();
        else size = size.toFixed(2);

        const orderData = {
            symbol: symbol, productType: 'USDT-FUTURES', marginMode: 'isolated', marginCoin: 'USDT',
            size: size.toString(), side: side, tradeSide: 'open', orderType: 'market' 
        };

        const response = await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderData);
        await sleep(2000);

        let recalculatedTakeProfit = action === 'buy' ? price * (1 + (tpPct / 100)) : price * (1 - (tpPct / 100));
        let recalculatedStopLoss = action === 'buy' ? price * (1 - (slPct / 100)) : price * (1 + (slPct / 100));

        let precision = 2; 
        if (symbol.includes('BTC')) precision = 1; 
        else if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE') || symbol.includes('BGB')) precision = 4; 
        else if (symbol.includes('ICP')) precision = 3; 

        try {
            const posTpslData = {
                symbol: symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', holdSide: holdSide,
                stopSurplusTriggerPrice: parseFloat(recalculatedTakeProfit).toFixed(precision), stopSurplusTriggerType: 'mark_price',
                stopLossTriggerPrice: parseFloat(recalculatedStopLoss).toFixed(precision), stopLossTriggerType: 'mark_price',
            };
            await bitgetRequest('POST', '/api/v2/mix/order/place-pos-tpsl', posTpslData);
        } catch (errPosTpsl) {
            console.error('[BOT] Erro ao configurar TP/SL:', errPosTpsl.message);
        }
        return response;
    } catch (error) { throw error; }
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

                // Chamada corrigida (sem o tamanho da posição)
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

// Rota para o webhook
app.post('/webhook-bot', async (req, res) => {
    try {
        const body = req.body;

        if (body.action === 'close' || (body.result_icon && body.placar_str)) {

            if (body.symbol) {
                const normalizedSymbol = body.symbol.replace('_', '').toUpperCase();
                const openPosition = await getOpenPositionData(normalizedSymbol);
                if (openPosition) {
                    try {
                        // Chamada corrigida (sem o tamanho da posição)
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