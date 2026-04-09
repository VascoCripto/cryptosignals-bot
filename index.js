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

// NOVA FUNÇÃO: Para obter os detalhes de uma posição aberta específica, incluindo o preço de entrada
const getPositionDetails = async (symbol, holdSide) => {
    try {
        const response = await bitgetRequest('GET', `/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT`);
        if (response && response.data && response.data.length > 0) {
            // Filtra pela moeda e pelo lado da posição (long/short)
            const position = response.data.find(pos => pos.symbol === symbol && pos.holdSide === holdSide && parseFloat(pos.total) > 0);
            return position; // Retorna o objeto da posição
        }
        return null;
    } catch (error) {
        console.error('[BOT] Erro ao obter detalhes da posição:', error.message);
        return null;
    }
};

// Função para configurar a alavancagem
const setLeverage = async (symbol, leverage, holdSide) => {
    try {
        console.log(`[BOT] Configurando alavancagem para ${leverage}x no par ${symbol}...`);
        await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
            symbol: symbol,
            productType: 'USDT-FUTURES',
            marginCoin: 'USDT',
            leverage: leverage.toString(),
            holdSide: holdSide
        });
        console.log('[BOT] Alavancagem configurada com sucesso!');
    } catch (error) {
        console.log('[BOT] Aviso ao configurar alavancagem:', error.message);
    }
};

// Função para enviar ordem (compra/venda) e configurar TP/SL
// Agora recebe slPct e tpPct para recalcular o TP/SL com base no preço de entrada real
const placeOrder = async (symbol, action, price, stopLoss, takeProfit, slPct, tpPct) => {
    try {
        const side = action === 'buy' ? 'buy' : 'sell';
        const holdSide = action === 'buy' ? 'long' : 'short';

        // --- 1. FORÇA A ALAVANCAGEM PARA 10X ---
        const alavancagem = 10;
        await setLeverage(symbol, alavancagem, holdSide);

        // --- 2. CÁLCULO AUTOMÁTICO DO TAMANHO DA ORDEM ---
        let margemDesejada = 5; // Margem padrão de $5 USD

        // Ajusta a margem desejada para moedas de baixo/médio valor
        if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE')) { 
            margemDesejada = 30; // Aumenta para $30 USD de margem para moedas muito baratas
        } else if (symbol.includes('AVAX') || symbol.includes('DOT') || symbol.includes('SOL') || symbol.includes('BNB') || symbol.includes('ETH') || symbol.includes('ICP') || symbol.includes('ZEC')) { 
            margemDesejada = 15; // Aumenta para $15 USD de margem para moedas de preço médio
        }
        // Para BGBUSDT, se for operado, ele se encaixaria na primeira condição (margemDesejada = 30)

        const tamanhoTotalDaPosicao = margemDesejada * alavancagem; 

        let size;
        // Precisão do SIZE (quantidade de contratos)
        if (symbol.includes('BTC')) {
            size = (tamanhoTotalDaPosicao / price).toFixed(4); 
        } else if (symbol.includes('ETH')) {
            size = (tamanhoTotalDaPosicao / price).toFixed(3); 
        } else if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE')) { 
            size = (tamanhoTotalDaPosicao / price).toFixed(0); // Arredonda para 0 casas decimais (inteiro)
        } else { // Para ICP, DOT, AVAX, ZEC, SOL e outros que não se encaixam acima
            size = (tamanhoTotalDaPosicao / price).toFixed(2); // Padrão para outras moedas
        }

        console.log(`[BOT] Margem desejada: ${margemDesejada} USD, Tamanho total da posição: ${tamanhoTotalDaPosicao} USD, Preço: ${price}, Size calculado: ${size}`);

        // --- 3. PASSO 1: ABRIR A POSIÇÃO A MERCADO ---
        const orderData = {
            symbol: symbol,
            productType: 'USDT-FUTURES',
            marginMode: 'isolated',
            marginCoin: 'USDT',
            size: size,
            side: side,
            tradeSide: 'open',
            orderType: 'market'
        };

        console.log('[BOT] Enviando ordem principal a mercado:', orderData);
        const response = await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderData);
        console.log('[BOT] Ordem principal executada com sucesso!');

        // --- AGUARDA 5 SEGUNDOS PARA A CORRETORA PROCESSAR A POSIÇÃO ---
        console.log('[BOT] Aguardando 5 segundos para sincronização da posição na Bitget...');
        await sleep(5000); // Aumentado para 5 segundos

        // --- NOVO PASSO: OBTER O PREÇO DE ENTRADA REAL DA POSIÇÃO ---
        const positionDetails = await getPositionDetails(symbol, holdSide);
        if (!positionDetails || !positionDetails.openPriceAvg) { 
            console.error('[BOT] Erro: positionDetails ou openPriceAvg não encontrados. Detalhes da posição:', positionDetails);
            throw new Error('Não foi possível obter o preço de entrada real da posição na Bitget após a execução da ordem.');
        }
        const realEntryPrice = parseFloat(positionDetails.openPriceAvg); 
        console.log(`[BOT] Preço de entrada real da posição na Bitget: ${realEntryPrice}`);

        // --- LOG DETALHADO PARA DEBUG DO TP/SL ---
        console.log(`[BOT] slPct recebido do TradingView: ${slPct}%, tpPct recebido do TradingView: ${tpPct}%`);
        console.log(`[BOT] realEntryPrice para cálculo de TP/SL: ${realEntryPrice}`);

        // --- RECALCULAR TP/SL COM BASE NO PREÇO DE ENTRADA REAL ---
        let recalculatedTakeProfit;
        let recalculatedStopLoss;

        // slPct e tpPct já vêm como números (ex: 1.54, 2.31, sempre positivos representando a magnitude)
        if (action === 'buy') { // LONG
            recalculatedTakeProfit = realEntryPrice * (1 + (tpPct / 100));
            recalculatedStopLoss = realEntryPrice * (1 - (slPct / 100)); // SL para LONG é ABAIXO do preço de entrada
        } else { // SHORT
            recalculatedTakeProfit = realEntryPrice * (1 - (tpPct / 100)); // TP para SHORT é ABAIXO do preço de entrada
            recalculatedStopLoss = realEntryPrice * (1 + (slPct / 100)); // SL para SHORT é ACIMA do preço de entrada
        }

        // Determinar a precisão para arredondamento (ajuste conforme a Bitget aceita para cada par)
        let precision = 2; // Padrão para USDT
        if (symbol.includes('BTC')) precision = 1; 
        else if (symbol.includes('ETH')) precision = 2; 
        else if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE')) precision = 4; 
        else if (symbol.includes('AVAX') || symbol.includes('DOT') || symbol.includes('SOL') || symbol.includes('BNB') || symbol.includes('ICP') || symbol.includes('ZEC')) precision = 2; // Para esses, 2 casas decimais para preço
        // Se BGBUSDT for operado, ele provavelmente precisaria de precision = 4

        recalculatedTakeProfit = parseFloat(recalculatedTakeProfit).toFixed(precision);
        recalculatedStopLoss = parseFloat(recalculatedStopLoss).toFixed(precision);

        console.log(`[BOT] TP recalculado com base no preço de entrada real (${realEntryPrice}): ${recalculatedTakeProfit}`);
        console.log(`[BOT] SL recalculado com base no preço de entrada real (${realEntryPrice}): ${recalculatedStopLoss}`);

        // --- 4. PASSO 2: GRAMPEAR O TP E SL NA POSIÇÃO ABERTA USANDO O ENDPOINT CORRETO ---
        try {
            const posTpslData = {
                symbol: symbol,
                productType: 'USDT-FUTURES',
                marginCoin: 'USDT', 
                holdSide: holdSide,
                // Take Profit (usando o valor recalculado)
                stopSurplusTriggerPrice: recalculatedTakeProfit.toString(),
                stopSurplusTriggerType: 'mark_price',
                // Stop Loss (usando o valor recalculado)
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

        // 1. ENVIA A MENSAGEM PARA O TELEGRAM PRIMEIRO
        // Usar os valores de TP/SL do JSON original, pois o recálculo ocorre APÓS o envio da mensagem
        const telegramMsg =
            `${emoji} *SINAL DE ${tipo

