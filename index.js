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
const bot = new TelegramBot(telegramToken, { polling: false });

// Configurações da Bitget
const bitgetApiKey = process.env.BITGET_API_KEY;
const bitgetApiSecret = process.env.BITGET_API_SECRET;
const bitgetApiPassphrase = process.env.BITGET_PASSPHRASE;
const bitgetApiUrl = 'https://api.bitget.com';

// Função para pausar a execução (delay)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Função para gerar a assinatura (HMAC SHA256)
const generateSignature = (timestamp, method, requestPath, body = '') => {
    const message = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', bitgetApiSecret).update(message).digest('base64');
};

// Função para fazer requisições autenticadas à Bitget
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
        if (method !== 'GET') {
            config.data = body;
        }

        const response = await axios(config);
        return response.data;
    } catch (error) {
        const errorDetails = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
        console.error('[BOT] Erro na requisição Bitget API:', errorDetails);
        throw new Error(errorDetails);
    }
};

// Obter saldo disponível na conta de futuros
const getAvailableBalance = async () => {
    try {
        const response = await bitgetRequest('GET', '/api/v2/account/all-account-balance'); 
        if (response && response.data && Array.isArray(response.data)) {
            const futuresAccount = response.data.find(acc => acc.accountType === 'futures');
            if (futuresAccount && futuresAccount.usdtBalance !== undefined) {
                return parseFloat(futuresAccount.usdtBalance);
            }
        }
        return 0;
    } catch (error) {
        console.error('[BOT] Erro ao obter saldo:', error.message);
        return 0;
    }
};

// Função para verificar posições abertas
const getOpenPositions = async (symbol) => {
    try {
        const response = await bitgetRequest('GET', `/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT`);
        if (response && response.data && response.data.length > 0) {
            const positions = response.data.filter(pos => pos.symbol === symbol && parseFloat(pos.total) > 0);
            return positions.length > 0;
        }
        return false;
    } catch (error) {
        return false;
    }
};

// Função para configurar alavancagem
const setLeverage = async (symbol, leverage, holdSide) => {
    try {
        await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
            symbol: symbol,
            marginCoin: 'USDT',
            leverage: leverage.toString(),
            holdSide: holdSide,
            productType: 'USDT-FUTURES'
        });
    } catch (error) {
        console.log('[BOT] Aviso ao configurar alavancagem:', error.message);
    }
};

// Função para enviar ordem (compra/venda) e configurar TP/SL
const placeOrder = async (symbol, action, price, stopLoss, takeProfit, slPct, tpPct) => {
    try {
        const side = action === 'buy' ? 'buy' : 'sell';
        const holdSide = action === 'buy' ? 'long' : 'short';

        let alavancagem = 10;
        if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE') || symbol.includes('ICP')) {
            alavancagem = 5;
        }
        await setLeverage(symbol, alavancagem, holdSide);

        const availableBalance = await getAvailableBalance();
        const marginToUse = 10; 

        if (availableBalance < marginToUse) {
            throw new Error(`Saldo insuficiente. Necessário: ${marginToUse} USDT, Disponível: ${availableBalance.toFixed(4)} USDT`);
        }

        let size = (marginToUse * alavancagem) / price;

        if (symbol.includes('BTC')) size = size.toFixed(3);
        else if (symbol.includes('ETH')) size = size.toFixed(2);
        else if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE')) size = Math.floor(size).toString();
        else if (symbol.includes('ICP')) size = size.toFixed(2);
        else if (symbol.includes('AVAX') || symbol.includes('DOT') || symbol.includes('SOL') || symbol.includes('BNB') || symbol.includes('ZEC')) size = size.toFixed(1);
        else if (symbol.includes('BGB')) size = Math.floor(size).toString();
        else size = size.toFixed(2);

        const orderData = {
            symbol: symbol,
            productType: 'USDT-FUTURES',
            marginMode: 'isolated', 
            marginCoin: 'USDT',
            size: size.toString(), 
            side: side, 
            tradeSide: 'open', 
            orderType: 'market' 
        };

        const response = await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderData);
        await sleep(2000);

        let realEntryPrice = price;
        let recalculatedTakeProfit = takeProfit;
        let recalculatedStopLoss = stopLoss;

        if (action === 'buy') { 
            recalculatedTakeProfit = realEntryPrice * (1 + (tpPct / 100)); 
            recalculatedStopLoss = realEntryPrice * (1 - (slPct / 100)); 
        } else { 
            recalculatedTakeProfit = realEntryPrice * (1 - (tpPct / 100)); 
            recalculatedStopLoss = realEntryPrice * (1 + (slPct / 100)); 
        }

        let precision = 2; 
        if (symbol.includes('BTC')) precision = 1; 
        else if (symbol.includes('ETH')) precision = 2; 
        else if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE')) precision = 4; 
        else if (symbol.includes('ICP')) precision = 3; 
        else if (symbol.includes('AVAX') || symbol.includes('DOT') || symbol.includes('SOL') || symbol.includes('BNB') || symbol.includes('ZEC')) precision = 2; 
        else if (symbol.includes('BGB')) precision = 4; 

        recalculatedTakeProfit = parseFloat(recalculatedTakeProfit).toFixed(precision);
        recalculatedStopLoss = parseFloat(recalculatedStopLoss).toFixed(precision);

        try {
            const posTpslData = {
                symbol: symbol,
                productType: 'USDT-FUTURES',
                marginCoin: 'USDT', 
                holdSide: holdSide,
                stopSurplusTriggerPrice: recalculatedTakeProfit.toString(),
                stopSurplusTriggerType: 'mark_price',
                stopLossTriggerPrice: recalculatedStopLoss.toString(),
                stopLossTriggerType: 'mark_price',
            };
            await bitgetRequest('POST', '/api/v2/mix/order/place-pos-tpsl', posTpslData);
        } catch (errPosTpsl) {
            console.error('[BOT] Erro ao configurar TP/SL:', errPosTpsl.message);
            // AGORA ELE GERA UM ERRO REAL SE O TP/SL FALHAR
            throw new Error(`A ordem foi aberta, mas a Bitget recusou o TP/SL. Motivo: ${errPosTpsl.message}`);
        }

        return response;
    } catch (error) {
        throw error;
    }
};

// Função principal para lidar com os sinais
const handleSignal = async (body) => {
    let normalizedSymbol = '';
    try {
        const { action, symbol, price, stopLoss, takeProfit, slPct, tpPct, timeframe, wins, losses, winRate } = body;

        if (!action || !symbol || !price || !stopLoss || !takeProfit || slPct === undefined || tpPct === undefined) {
            return;
        }

        normalizedSymbol = symbol.replace('_', '').toUpperCase();
        const tipo = action === 'buy' ? 'COMPRA (LONG)' : 'VENDA (SHORT)';
        const emoji = action === 'buy' ? '🟢' : '🔴';
        const bitgetLink = `https://www.bitget.com/pt-BR/mix/usdt/${normalizedSymbol}?type=futures`;

        const telegramMsg =
            `${emoji} *SINAL DE ${tipo}*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📌 *Par:* ${normalizedSymbol}\n` +
            `⏱ *Timeframe:* ${timeframe}\n` +
            `⚙️ *Alavancagem:* 10x\n\n` + 
            `💰 *Entrada:* \`${price}\`\n` +
            `🎯 *Take Profit:* \`${takeProfit}\` (${tpPct > 0 ? '+' : ''}${tpPct}%)\n` +
            `🛑 *Stop Loss:* \`${stopLoss}\` (${slPct > 0 ? '-' : ''}${slPct}%)\n` +
            `📊 *Placar Geral:* ${wins}W - ${losses}L (${winRate}%)\n` +
            `🔗 [Operar na Bitget: Clique aqui](${bitgetLink})\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `_Sinal gerado por IA_`;

        await bot.sendMessage(telegramChatId, telegramMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });

        const hasOpenPosition = await getOpenPositions(normalizedSymbol);
        if (hasOpenPosition) {
            await bot.sendMessage(telegramChatId, `⚠️ _Aviso do Bot: O sinal acima não foi executado pois já existe uma posição aberta para ${normalizedSymbol}._`, { parse_mode: 'Markdown' });
            return;
        }

        await placeOrder(normalizedSymbol, action, price, stopLoss, takeProfit, slPct, tpPct);

        if (await getOpenPositions(normalizedSymbol)) { 
            await bot.sendMessage(telegramChatId, `✅ Ordem automática de ${tipo} para ${normalizedSymbol} executada com sucesso e protegida com TP/SL!`, { parse_mode: 'Markdown' });
        }

    } catch (error) {
        console.error('[BOT] Erro fatal ao processar sinal:', error.message);

        if (error.message.includes('40762') || error.message.includes('exceeds the balance') || error.message.includes('Saldo insuficiente')) {
            const msgSaldo = 
                `⚠️ *Aviso de Saldo*\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `A operação para **${normalizedSymbol || 'o ativo'}** não pôde ser aberta.\n\n` +
                `**Motivo:** Saldo insuficiente na corretora.\n` +
                `_Por favor, adicione fundos à sua conta de futuros da Bitget para continuar operando._\n` +
                `━━━━━━━━━━━━━━━━━━━━`;
            await bot.sendMessage(telegramChatId, msgSaldo, { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(telegramChatId, `❌ *Aviso:* Não foi possível executar a ordem de ${normalizedSymbol || 'ativo'}. Motivo: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }
};

// Rota para o webhook
app.post('/webhook-bot', async (req, res) => {
    try {
        const body = req.body;

        if (body.result_icon && body.placar_str) {
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
        } else {
            await handleSignal(body);
        }

        res.status(200).send('OK');
    } catch (error) {
        res.status(500).send('Erro interno do servidor');
    }
});

app.get('/', (req, res) => {
    res.status(200).send('Bot de sinais está online!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Servidor na porta ${PORT}`);
});