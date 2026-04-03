const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
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
const bitgetApiPassphrase = process.env.BITGET_API_PASSPHRASE;
const bitgetApiUrl = 'https://api.bitget.com'; // Ou 'https://api.bitget.com' para produção

// Função para gerar a assinatura (HMAC SHA256)
const generateSignature = (timestamp, method, requestPath, body = '') => {
    const message = timestamp + method + requestPath + body;
    const crypto = require('crypto');
    return crypto.createHmac('sha256', bitgetApiSecret).update(message).digest('base64');
};

// Função para fazer requisições autenticadas à Bitget
const bitgetRequest = async (method, endpoint, data = {}) => {
    const timestamp = Date.now().toString();
    const requestPath = `/api/v2/mix/account/${endpoint}`; // Ajuste o path conforme a API v2
    const body = method === 'GET' ? '' : JSON.stringify(data);
    const signature = generateSignature(timestamp, method, requestPath, body);

    try {
        const headers = {
            'Content-Type': 'application/json',
            'X-BG-APIKEY': bitgetApiKey,
            'X-BG-TIMESTAMP': timestamp,
            'X-BG-SIGN': signature,
            'X-BG-PASSPHRASE': bitgetApiPassphrase,
            'X-BG-RETRY': 'false'
        };

        const config = { method, url: `${bitgetApiUrl}${requestPath}`, headers };
        if (method !== 'GET') {
            config.data = body;
        }

        const response = await axios(config);
        console.log('[BOT] Resposta API:', response.data);
        return response.data;
    } catch (error) {
        console.error('[BOT] Erro na requisição Bitget API:', error.response ? error.response.data : error.message);
        throw error;
    }
};

// Função para verificar posições abertas
const getOpenPositions = async (symbol) => {
    try {
        // Ajuste o endpoint conforme a API v2 para obter posições
        // Exemplo: /api/v2/mix/position/openPositions (verifique a documentação da Bitget v2)
        const response = await bitgetRequest('GET', `position/allFills?symbol=${symbol}`); // Exemplo, ajuste para o endpoint correto de posições abertas
        // A lógica aqui pode precisar ser ajustada dependendo da estrutura da resposta da API v2
        // Você precisará iterar sobre 'data' e verificar se há posições ativas para o símbolo
        if (response && response.data && response.data.length > 0) {
            console.log(`[BOT] Posições abertas para ${symbol}:`, response.data.length);
            return response.data.filter(pos => pos.symbol === symbol && pos.holdSide !== 'none').length > 0;
        }
        return false;
    } catch (error) {
        console.error('[BOT] Erro ao verificar posições abertas:', error.message);
        return false;
    }
};

// Função para enviar ordem (compra/venda)
const placeOrder = async (symbol, side, price, stopLoss, takeProfit) => {
    try {
        // Ajuste o endpoint e o payload conforme a API v2 para colocar ordens
        const orderData = {
            symbol: symbol,
            side: side, // 'buy' ou 'sell'
            orderType: 'limit', // Ou 'market'
            price: price.toString(),
            size: '0.001', // Ajuste o tamanho da ordem conforme sua estratégia e par
            marginCoin: 'USDT',
            tradeSide: side === 'buy' ? 'open_long' : 'open_short', // 'open_long' ou 'open_short'
            timeInForce: 'gtc',
            // stopLoss: stopLoss.toString(), // A Bitget pode exigir que SL/TP sejam ordens separadas ou em um formato específico
            // takeProfit: takeProfit.toString()
        };
        console.log('[BOT] Tentando colocar ordem:', orderData);
        const response = await bitgetRequest('POST', 'order/placeOrder', orderData); // Exemplo, ajuste para o endpoint correto
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
            await bot.sendMessage(telegramChatId, `❌ Erro: Sinal JSON incompleto ou inválido recebido. Detalhes: ${JSON.stringify(body)}`, { parse_mode: 'Markdown' });
            return;
        }

        const tipo = action === 'buy' ? 'COMPRA (LONG)' : 'VENDA (SHORT)';
        const emoji = action === 'buy' ? '🟢' : '🔴';
        const bitgetLink = `https://www.bitget.com/pt-BR/mix/usdt/${symbol.replace('USDT', '_USDT')}?type=futures`;

        // Verifica se já existe uma posição aberta para o símbolo
        const hasOpenPosition = await getOpenPositions(symbol);
        if (hasOpenPosition) {
            console.log('[BOT] Já existe uma posição aberta. Sinal ignorado.');
            await bot.sendMessage(telegramChatId, `⚠️ *Sinal Ignorado:* Já existe uma posição aberta para ${symbol}.`, { parse_mode: 'Markdown' });
            return;
        }

        // Envia a mensagem para o Telegram
        const telegramMsg =
            `${emoji} *SINAL DE ${tipo}*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📌 *Par:* ${symbol}\n` +
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
        const orderSide = action === 'buy' ? 'open_long' : 'open_short'; // Ajuste conforme a Bitget API v2
        const orderResult = await placeOrder(symbol, orderSide, price, stopLoss, takeProfit);
        console.log('[BOT] Resultado da ordem:', orderResult);

        await bot.sendMessage(telegramChatId, `✅ Ordem de ${tipo} para ${symbol} enviada com sucesso!`, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('[BOT] Erro fatal ao processar sinal:', error.message);
        await bot.sendMessage(telegramChatId, `❌ *Erro Crítico:* Falha ao processar sinal. Detalhes: ${error.message}`, { parse_mode: 'Markdown' });
    }
};

// Rota para o webhook do TradingView
app.post('/webhook-bot', async (req, res) => {
    try {
        const body = req.body;
        // console.log('[WEBHOOK] Requisição recebida:', JSON.stringify(body)); // Log mais detalhado da requisição bruta

        // Verifica se é um sinal de saída (TP/SL atingido)
        if (body.result_icon && body.placar_str) { // Adapte esta condição para o formato do seu alerta de saída
            console.log('[BOT] Mensagem de saída detectada, enviando ao Telegram...');
            const exitMsg = body.result_icon + "\n" +
                            "━━━━━━━━━━━━━━━━━━━━\n" +
                            "📌 *Par:* "        + body.pair_name + "\n" +
                            "⏱ *Timeframe:* "  + body.timeframe + "\n" +
                            "🔄 *Operação:* "   + body.trade_dir + "\n" +
                            "💰 *Entrada:* `"   + body.entry_price + "`\n" +
                            "🏁 *Saída:* `"     + body.exit_price + "`\n" +
                            "💵 *Resultado:* "  + body.result_text + "\n" + // Assumindo que você adicionou result_text no alerta de saída
                            "━━━━━━━━━━━━━━━━━━━━" + body.placar_str;

            await bot.sendMessage(telegramChatId, exitMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
            console.log('[BOT] Mensagem de saída enviada ao Telegram');
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