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

// FUNÇÃO ATUALIZADA: Obter saldo disponível na conta de futuros
const getAvailableBalance = async () => {
    try {
        const response = await bitgetRequest('GET', '/api/v2/account/all-account-balance'); 
        if (response && response.data && Array.isArray(response.data)) {
            const futuresAccount = response.data.find(acc => acc.accountType === 'futures');
            if (futuresAccount && futuresAccount.usdtBalance !== undefined) {
                console.log('[BOT] Detalhes completos da conta de futuros encontrados:', JSON.stringify(futuresAccount, null, 2));
                return parseFloat(futuresAccount.usdtBalance);
            }
        }
        console.log('[BOT] Nenhum saldo USDT encontrado na conta de futuros ou saldo zero.');
        return 0;
    } catch (error) {
        console.error('[BOT] Erro ao obter saldo disponível da conta de futuros:', error.message);
        return 0;
    }
};

// Função para verificar posições abertas (retorna true/false)
const getOpenPositions = async (symbol) => {
    try {
        const response = await bitgetRequest('GET', `/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT`);
        if (response && response.data && response.data.length > 0) {
            const positions = response.data.filter(pos => pos.symbol === symbol && parseFloat(pos.total) > 0);
            return positions.length > 0;
        }
        return false;
    } catch (error) {
        console.error('[BOT] Erro ao verificar posições abertas:', error.message);
        return false;
    }
};

// Função para obter os detalhes de uma posição aberta específica
const getPositionDetails = async (symbol, holdSide) => {
    try {
        const response = await bitgetRequest('GET', `/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT`);
        if (response && response.data && response.data.length > 0) {
            const position = response.data.find(pos => pos.symbol === symbol && pos.holdSide === holdSide && parseFloat(pos.total) > 0);
            return position;
        }
        return null;
    } catch (error) {
        console.error('[BOT] Erro ao obter detalhes da posição:', error.message);
        throw error;
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
        console.log(`[BOT] Alavancagem configurada para ${leverage}x com sucesso!`);
    } catch (error) {
        console.log('[BOT] Aviso ao configurar alavancagem:', error.message);
    }
};

// Função para enviar ordem (compra/venda) e configurar TP/SL
const placeOrder = async (symbol, action, price, stopLoss, takeProfit, slPct, tpPct) => {
    try {
        const side = action === 'buy' ? 'buy' : 'sell';
        const holdSide = action === 'buy' ? 'long' : 'short';

        // --- 1. FORÇA A ALAVANCAGEM ---
        let alavancagem = 10; 

        if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE') || symbol.includes('BGB') || symbol.includes('ICP')) {
            alavancagem = 5; 
        } else if (symbol.includes('ZEC')) { 
            alavancagem = 10; 
        }
        await setLeverage(symbol, alavancagem, holdSide);

        // --- 2. CÁLCULO AUTOMÁTICO DO TAMANHO DA ORDEM ---
        let margemDesejada = 5; 

        if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE')) {
            margemDesejada = 5; 
        } else if (symbol.includes('BGB') || symbol.includes('ICP') || symbol.includes('ZEC')) { 
            margemDesejada = 10; 
        } else if (symbol.includes('AVAX') || symbol.includes('DOT') || symbol.includes('SOL') || symbol.includes('BNB') || symbol.includes('ETH')) {
            margemDesejada = 15; 
        }

        const tamanhoTotalDaPosicao = margemDesejada * alavancagem; 

        let size;
        if (symbol.includes('BTC')) {
            size = (tamanhoTotalDaPosicao / price).toFixed(4); 
        } else if (symbol.includes('ETH')) {
            size = (tamanhoTotalDaPosicao / price).toFixed(3); 
        } else if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE') || symbol.includes('BGB') || symbol.includes('DOT')) {
            size = (tamanhoTotalDaPosicao / price).toFixed(0); 
        } else if (symbol.includes('ZEC')) {
            size = ((tamanhoTotalDaPosicao / price) / 10).toFixed(2); 
        } else if (symbol.includes('ICP') || symbol.includes('AVAX') || symbol.includes('SOL') || symbol.includes('BNB')) { 
            size = (tamanhoTotalDaPosicao / price).toFixed(2); 
        } else { 
            size = (tamanhoTotalDaPosicao / price).toFixed(2); 
        }

        const availableBalance = await getAvailableBalance();

        console.log(`[BOT] Saldo disponível na Bitget (lido pelo bot): ${availableBalance} USDT`);
        console.log(`[BOT] Margem desejada: ${margemDesejada} USD, Alavancagem: ${alavancagem}x, Tamanho total da posição: ${tamanhoTotalDaPosicao} USD, Preço: ${price}, Size calculado: ${size}`);

        if (availableBalance < margemDesejada) {
            throw new Error(`Saldo insuficiente na conta de futuros da Bitget. Necessário: ${margemDesejada} USDT, Disponível: ${availableBalance} USDT.`);
        }

        // --- 3. PASSO 1: ENVIAR A ORDEM PRINCIPAL (MODO UNILATERAL) ---
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
        console.log('[BOT] Enviando ordem principal a mercado:', orderData);
        const response = await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderData);
        console.log('[BOT] Ordem principal executada com sucesso!');

        // --- AGUARDA 5 SEGUNDOS PARA A CORRETORA PROCESSAR A POSIÇÃO ---
        console.log('[BOT] Aguardando 5 segundos para sincronização da posição na Bitget...');
        await sleep(5000); 

        // --- NOVO PASSO: OBTER O PREÇO DE ENTRADA REAL DA POSIÇÃO ---
        const positionDetails = await getPositionDetails(symbol, holdSide);
        if (!positionDetails || !positionDetails.openPriceAvg) { 
            console.error('[BOT] Erro: positionDetails ou openPriceAvg não encontrados. Detalhes da posição:', positionDetails);
            throw new Error('Não foi possível obter o preço de entrada real da posição na Bitget após a execução da ordem.');
        }
        const realEntryPrice = parseFloat(positionDetails.openPriceAvg); 
        console.log(`[BOT] Preço de entrada real da posição na Bitget: ${realEntryPrice}`);

        // --- RECALCULAR TP/SL COM BASE NO PREÇO DE ENTRADA REAL ---
        let recalculatedTakeProfit;
        let recalculatedStopLoss;

        if (action === 'buy') { 
            recalculatedTakeProfit = realEntryPrice * (1 + (tpPct / 100));
            recalculatedStopLoss = realEntryPrice * (1 - (slPct / 100)); 
        } else { 
            recalculatedTakeProfit = realEntryPrice * (1 - (tpPct / 100)); 
            recalculatedStopLoss = realEntryPrice * (1 + (slPct / 100)); 
        }

        // --- AJUSTE DE PRECISÃO (ICP CORRIGIDA PARA 3) ---
        let precision = 2; 
        if (symbol.includes('BTC')) precision = 1; 
        else if (symbol.includes('ETH')) precision = 2; 
        else if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE')) precision = 4; 
        else if (symbol.includes('ICP')) precision = 3; 
        else if (symbol.includes('AVAX') || symbol.includes('DOT') || symbol.includes('SOL') || symbol.includes('BNB') || symbol.includes('ZEC')) precision = 2; 
        else if (symbol.includes('BGB')) precision = 4; 

        recalculatedTakeProfit = parseFloat(recalculatedTakeProfit).toFixed(precision);
        recalculatedStopLoss = parseFloat(recalculatedStopLoss).toFixed(precision);

        console.log(`[BOT] TP recalculado com base no preço de entrada real (${realEntryPrice}): ${recalculatedTakeProfit}`);
        console.log(`[BOT] SL recalculado com base no preço de entrada real (${realEntryPrice}): ${recalculatedStopLoss}`);

        // --- 4. PASSO 2: GRAMPEAR O TP E SL NA POSIÇÃO ABERTA ---
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
            console.log('[BOT] Configurando Take Profit e Stop Loss na posição:', posTpslData);
            await bitgetRequest('POST', '/api/v2/mix/order/place-pos-tpsl', posTpslData);
            console.log('[BOT] TP e SL configurados com sucesso e visíveis na Bitget!');
        } catch (errPosTpsl) {
            console.error('[BOT] Erro ao configurar TP/SL na posição:', errPosTpsl.message);
            throw new Error(`A ordem foi aberta, mas a Bitget recusou o TP/SL da posição. Erro: ${errPosTpsl.message}`);
        }

        return response;
    } catch (error) {
        console.error('[BOT] Erro na função placeOrder:', error.message);
        throw error;
    }
};

// Função principal para lidar com os sinais do TradingView
const handleSignal = async (body) => {
    try {
        console.log('[BOT] Sinal de entrada JSON recebido:', JSON.stringify(body));

        const { action, symbol, price, stopLoss, takeProfit, slPct, tpPct, timeframe, wins, losses, winRate } = body;

        if (!action || !symbol || !price || !stopLoss || !takeProfit || slPct === undefined || tpPct === undefined) {
            console.error('[BOT] Erro: Sinal JSON incompleto ou inválido. Certifique-se de que slPct e tpPct estão presentes.');
            return;
        }

        const normalizedSymbol = symbol.replace('_', '').toUpperCase();
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
        console.log('[BOT] Telegram de entrada enviado para o grupo VIP');

        const hasOpenPosition = await getOpenPositions(normalizedSymbol);
        if (hasOpenPosition) {
            console.log('[BOT] Já existe uma posição aberta. Ordem na Bitget ignorada.');
            await bot.sendMessage(telegramChatId, `⚠️ _Aviso do Bot: O sinal acima não foi executado na conta automática pois já existe uma posiçãão aberta para ${normalizedSymbol}._`, { parse_mode: 'Markdown' });
            return;
        }

        await placeOrder(normalizedSymbol, action, price, stopLoss, takeProfit, slPct, tpPct);
        console.log('[BOT] Operação concluída com sucesso!');

        if (await getOpenPositions(normalizedSymbol)) { 
            await bot.sendMessage(telegramChatId, `✅ Ordem automática de ${tipo} para ${normalizedSymbol} executada com sucesso e protegida com TP/SL!`, { parse_mode: 'Markdown' });
        }

    } catch (error) {
        console.error('[BOT] Erro fatal ao processar sinal:', error.message);
        await bot.sendMessage(telegramChatId, `❌ *Erro Crítico:* Falha ao processar sinal. Detalhes: ${error.message}`, { parse_mode: 'Markdown' });
    }
};

// Rota para o webhook do TradingView
app.post('/webhook-bot', async (req, res) => {
    try {
        const body = req.body;

        if (body.result_icon && body.placar_str) {
            console.log('[BOT] Mensagem de saída detectada, enviando ao Telegram...');
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
        console.error('[WEBHOOK] Erro no endpoint do webhook:', error.message);
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