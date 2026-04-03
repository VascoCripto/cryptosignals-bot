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
const bitgetApiPassphrase = process.env.BITGET_PASSPHRASE; // <-- CORRIGIDO AQUI (Tiramos o _API_)
const bitgetApiUrl = 'https://api.bitget.com';

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
        console.error('[BOT] Erro na requisição Bitget API:', error.response ? error.response.data : error.message);
        throw error;
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
        console.error('[BOT] Erro ao verificar posições abertas:', error.message);
        return false;
    }
};

// Função para enviar ordem (compra/venda) e configurar TP/SL
const placeOrder = async (symbol, action, price, stopLoss, takeProfit) => {
    try {
        const side = action === 'buy' ? 'buy' : 'sell';
        const holdSide = action === 'buy' ? 'long' : 'short';
        const size = '0.001'; // Ajuste o tamanho da ordem conforme sua banca

        const orderData = {
            symbol: symbol,
            productType: 'USDT-FUTURES',
            marginMode: 'isolated',
            marginCoin: 'USDT',
            size: size,
            side: side,
            tradeSide: 'open',
            orderType: 'market' // Usando market para garantir que a ordem entre na hora
        };

        console.log('[BOT] Tentando colocar ordem principal:', orderData);
        const response = await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderData);
        console.log('[BOT] Ordem principal enviada:', response);

        // Se a ordem principal abriu com sucesso, envia o Stop Loss e Take Profit
        if (response && response.code === '00000') {
            // Configura Stop Loss
            try {
                await bitgetRequest('POST', '/api/v2/mix/order/place-plan-order', {
                    symbol,
                    productType: 'USDT-FUTURES',
                    marginCoin: 'USDT',
                    planType: 'loss_plan',
                    triggerPrice: stopLoss.toString(),
                    triggerType: 'mark_price',
                    executePrice: '0',
                    holdSide: holdSide,
                    size: size
                });
                console.log('[BOT] Stop Loss configurado:', stopLoss);
            } catch (e) { console.log('[BOT] Erro ao colocar SL:', e.message); }

            // Configura Take Profit
            try {
                await bitgetRequest('POST', '/api/v2/mix/order/place-plan-order', {
                    symbol,
                    productType: 'USDT-FUTURES',
                    marginCoin: 'USDT',
                    planType: 'profit_plan',
                    triggerPrice: takeProfit.toString(),
                    triggerType: 'mark_price',
                    executePrice: '0',
                    holdSide: holdSide,
                    size: size
                });
                console.log('[BOT] Take Profit configurado:', takeProfit);
            } catch (e) { console.log('[BOT] Erro ao colocar TP:', e.message); }
        }

        return response;
    } catch (error) {
        console.error('[BOT] Erro ao colocar ordem:', error.message);
        throw error;
    }
};

// Função principal para lidar com os sinais do TradingView
const handleSignal = async (body) => {
    try {
        console.log('[BOT] Sinal de entrada JSON recebido:', JSON.stringify(body));

        const { action, symbol, price, stopLoss, takeProfit, slPct, tpPct, timeframe, wins, losses, winRate } = body;

        if (!action || !symbol || !price || !stopLoss || !takeProfit) {
            console.error('[BOT] Erro: Sinal JSON incompleto ou inválido.');
            await bot.sendMessage(telegramChatId, `❌ Erro: Sinal JSON incompleto ou inválido recebido.`, { parse_mode: 'Markdown' });
            return;
        }

        const normalizedSymbol = symbol.replace('_', '').toUpperCase();
        const tipo = action === 'buy' ? 'COMPRA (LONG)' : 'VENDA (SHORT)';
        const emoji = action === 'buy' ? '🟢' : '🔴';
        const bitgetLink = `https://www.bitget.com/pt-BR/mix/usdt/${normalizedSymbol}?type=futures`;

        // Verifica se já existe uma posição aberta para o símbolo
        const hasOpenPosition = await getOpenPositions(normalizedSymbol);
        if (hasOpenPosition) {
            console.log('[BOT] Já existe uma posição aberta. Sinal ignorado.');
            await bot.sendMessage(telegramChatId, `⚠️ *Sinal Ignorado:* Já existe uma posição aberta para ${normalizedSymbol}.`, { parse_mode: 'Markdown' });
            return;
        }

        // Envia a mensagem para o Telegram
        const telegramMsg =
            `${emoji} *SINAL DE ${tipo}*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📌 *Par:* ${normalizedSymbol}\n` +
            `⏱ *Timeframe:* ${timeframe}\n` +
            `⚙️ *Alavancagem:* 5x a 10x\n\n` +
            `💰 *Entrada:* \`${price}\`\n` +
            `🎯 *Take Profit:* \`${takeProfit}\` (${tpPct > 0 ? '+' : ''}${tpPct}%)\n` +
            `🛑 *Stop Loss:* \`${stopLoss}\` (${slPct > 0 ? '-' : ''}${slPct}%)\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📊 *Placar Geral:* ${wins}W - ${losses}L (${winRate}%)\n` +
            `🔗 [Operar na Bitget: Clique aqui](${bitgetLink})\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `_Sinal gerado por IA_`;

        await bot.sendMessage(telegramChatId, telegramMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
        console.log('[BOT] Telegram de entrada enviado');

        // Coloca a ordem na Bitget
        const orderResult = await placeOrder(normalizedSymbol, action, price, stopLoss, takeProfit);
        console.log('[BOT] Resultado da ordem:', orderResult);

        await bot.sendMessage(telegramChatId, `✅ Ordem de ${tipo} para ${normalizedSymbol} enviada com sucesso!`, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('[BOT] Erro fatal ao processar sinal:', error.message);
        await bot.sendMessage(telegramChatId, `❌ *Erro Crítico:* Falha ao processar sinal. Detalhes: ${error.message}`, { parse_mode: 'Markdown' });
    }
};

// Rota para o webhook do TradingView
app.post('/webhook-bot', async (req, res) => {
    try {
        const body = req.body;

        // Verifica se é um sinal de saída (TP/SL atingido)
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
            // Se não for um sinal de saída, trata como sinal de entrada
            await handleSignal(body);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('[WEBHOOK] Erro no endpoint do webhook:', error.message);
        res.status(500).send('Erro interno do servidor');
    }
});

// Rota de saúde para verificar se o bot está online
app.get('/', (req, res) => {
    res.status(200).send('Bot de sinais está online!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Servidor na porta ${PORT}`);
});