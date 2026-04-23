const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const telegramAdminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || telegramChatId;
const bot = new TelegramBot(telegramToken, { polling: false });

const bitgetApiKey = process.env.BITGET_API_KEY;
const bitgetApiSecret = process.env.BITGET_API_SECRET;
const bitgetApiPassphrase = process.env.BITGET_PASSPHRASE;
const bitgetApiUrl = 'https://api.bitget.com';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const escapeMarkdown = (text = '') => String(text)
  .replace(/\\/g, '\\\\')
  .replace(/_/g, '\\_')
  .replace(/\*/g, '\\*')
  .replace(/\[/g, '\\[')
  .replace(/\]/g, '\\]')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)')
  .replace(/~/g, '\\~')
  .replace(/`/g, '\\`')
  .replace(/>/g, '\\>')
  .replace(/#/g, '\\#')
  .replace(/\+/g, '\\+')
  .replace(/-/g, '\\-')
  .replace(/=/g, '\\=')
  .replace(/\|/g, '\\|')
  .replace(/\{/g, '\\{')
  .replace(/\}/g, '\\}')
  .replace(/\./g, '\\.')
  .replace(/!/g, '\\!');

const sendTelegramMarkdown = async (chatId, text) => {
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });
  } catch (error) {
    const errorInfo = error?.response?.body || error?.response?.data || error.message;
    console.error('[BOT] Erro ao enviar Telegram Markdown:', errorInfo);
    throw error;
  }
};

const sendTelegramPlain = async (chatId, text) => {
  try {
    await bot.sendMessage(chatId, text, {
      disable_web_page_preview: true
    });
  } catch (error) {
    const errorInfo = error?.response?.body || error?.response?.data || error.message;
    console.error('[BOT] Erro ao enviar Telegram texto puro:', errorInfo);
    throw error;
  }
};

const formatNumber = (value, decimals = 4) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? '-');
  return num.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

const normalizeSymbol = (raw) => String(raw || '').replace('_', '').toUpperCase();
const getPayloadSymbol = (body) => normalizeSymbol(body.symbol || body.pair_name);
const getTradeDir = (body) =>
  body.tradeDir ||
  body.trade_dir ||
  (body.action === 'buy' ? 'LONG' : body.action === 'sell' ? 'SHORT' : 'N/D');
const getEntryTime = (body) => body.entryTime || body.entry_time || '-';
const getExitTime = (body) => body.exitTime || body.exit_time || '-';

const getLeverageForSymbol = (symbol) => {
  if (
    symbol.includes('XRP') ||
    symbol.includes('ADA') ||
    symbol.includes('DOGE') ||
    symbol.includes('ICP')
  ) return 5;
  return 10;
};

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
    const errorDetails = error.response && error.response.data
      ? JSON.stringify(error.response.data)
      : error.message;

    console.error('[BOT] Erro na requisição Bitget API:', errorDetails);
    throw new Error(errorDetails);
  }
};

const getAvailableBalance = async () => {
  try {
    const response = await bitgetRequest(
      'GET',
      '/api/v2/mix/account/account?productType=USDT-FUTURES&marginCoin=USDT'
    );

    if (response && response.data) {
      const accountData = Array.isArray(response.data) ? response.data[0] : response.data;
      if (accountData && accountData.available !== undefined) {
        const saldo = parseFloat(accountData.available);
        console.log(`[BOT] Saldo livre lido com sucesso: ${saldo} USDT`);
        return saldo;
      }
    }

    return 0;
  } catch (error) {
    console.error('[BOT] Erro ao buscar saldo:', error.message);
    return 0;
  }
};

const getOpenPositionData = async (symbol) => {
  try {
    const response = await bitgetRequest(
      'GET',
      `/api/v2/mix/position/single-position?symbol=${symbol}&productType=USDT-FUTURES&marginCoin=USDT`
    );

    if (response && response.data && Array.isArray(response.data)) {
      const positions = response.data.filter(
        pos => pos.symbol === symbol && parseFloat(pos.total) > 0
      );
      if (positions.length > 0) return positions[0];
    }

    return null;
  } catch (error) {
    return null;
  }
};

const setLeverage = async (symbol, leverage, holdSide) => {
  try {
    const levData = {
      symbol,
      productType: 'USDT-FUTURES',
      marginCoin: 'USDT',
      leverage: leverage.toString(),
      holdSide
    };

    await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', levData);
  } catch (error) {
    console.log(`[BOT] Aviso ao ajustar alavancagem: ${error.message}`);
  }
};

const closePosition = async (symbol, holdSide) => {
  try {
    const orderData = {
      symbol,
      productType: 'USDT-FUTURES',
      marginCoin: 'USDT',
      holdSide
    };

    await bitgetRequest('POST', '/api/v2/mix/order/close-positions', orderData);
    console.log(`[BOT] Posição de ${symbol} (${holdSide}) fechada com sucesso.`);
  } catch (error) {
    throw new Error(`Falha ao fechar posição: ${error.message}`);
  }
};

const placeOrder = async (symbol, action, price, stopLoss, takeProfit) => {
  const side = action === 'buy' ? 'buy' : 'sell';
  const holdSide = action === 'buy' ? 'long' : 'short';
  const leverage = getLeverageForSymbol(symbol);

  await setLeverage(symbol, leverage, holdSide);
  await getAvailableBalance();

  const marginToUse = 10;
  let size = (marginToUse * leverage) / Number(price);

  if (symbol.includes('BTC')) size = size.toFixed(3);
  else if (symbol.includes('ETH')) size = size.toFixed(2);
  else if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE')) {
    size = Math.floor(size).toString();
  } else {
    size = size.toFixed(1);
  }

  const orderData = {
    symbol,
    productType: 'USDT-FUTURES',
    marginMode: 'isolated',
    marginCoin: 'USDT',
    size: size.toString(),
    price: String(price),
    side,
    orderType: 'market',
    holdSide,
    tradeSide: 'open'
  };

  await bitgetRequest('POST', '/api/v2/mix/order/place-order', orderData);
  await sleep(2000);

  const posTpslData = {
    symbol,
    productType: 'USDT-FUTURES',
    marginCoin: 'USDT',
    holdSide,
    stopSurplusTriggerPrice: String(takeProfit),
    stopSurplusTriggerType: 'mark_price',
    stopLossTriggerPrice: String(stopLoss),
    stopLossTriggerType: 'mark_price'
  };

  await bitgetRequest('POST', '/api/v2/mix/order/place-pos-tpsl', posTpslData);
};

const buildSignalDetails = (body) => {
  const symbol = getPayloadSymbol(body);
  const timeframe = body.timeframe || '-';
  const tradeDir = getTradeDir(body);
  const leverage = `${getLeverageForSymbol(symbol)}x`;
  const entryTime = getEntryTime(body);
  const price = formatNumber(body.price, 6);
  const takeProfit = formatNumber(body.takeProfit, 6);
  const stopLoss = formatNumber(body.stopLoss, 6);
  const tpPct = body.tpPct ?? '-';
  const slPct = body.slPct ?? '-';
  const wins = body.wins ?? 0;
  const losses = body.losses ?? 0;
  const winRate = body.winRate ?? 0;
  const bitgetLink = `https://www.bitget.com/pt-BR/mix/usdt/${symbol}?type=futures`;

  return {
    symbol,
    leverage,
    tradeDir,
    bitgetLink,
    details:
      `📌 *Par:* ${escapeMarkdown(symbol)}\n` +
      `⏱ *Timeframe:* ${escapeMarkdown(String(timeframe))}\n` +
      `🧭 *Direção:* ${escapeMarkdown(tradeDir)}\n` +
      `🕒 *Horário Entrada:* ${escapeMarkdown(String(entryTime))}\n` +
      `⚙️ *Alavancagem:* ${escapeMarkdown(leverage)}\n\n` +
      `💰 *Entrada:* \`${escapeMarkdown(price)}\`\n` +
      `🎯 *Take Profit:* \`${escapeMarkdown(takeProfit)}\` \\(${escapeMarkdown(String(tpPct))}%\\)\n` +
      `🛑 *Stop Loss:* \`${escapeMarkdown(stopLoss)}\` \\(${escapeMarkdown(String(slPct))}%\\)\n` +
      `📊 *Placar Geral:* ${escapeMarkdown(String(wins))}W \\- ${escapeMarkdown(String(losses))}L \\(${escapeMarkdown(String(winRate))}%\\)\n` +
      `🔗 [Operar na Bitget](${bitgetLink})\n`
  };
};

const translateBitgetError = (message = '') => {
  let motivoErro = message;

  if (motivoErro.includes('insufficient balance') || motivoErro.includes('balance')) {
    motivoErro = 'Saldo insuficiente para abrir esta operação.';
  } else if (motivoErro.includes('size')) {
    motivoErro = 'O valor da entrada é menor que o mínimo permitido pela corretora.';
  }

  return motivoErro;
};

const safeSendMarkdown = async (chatId, message, label = 'Telegram') => {
  try {
    await sendTelegramMarkdown(chatId, message);
  } catch (error) {
    console.error(`[BOT] Falha ao enviar mensagem Markdown (${label}):`, error.message);
  }
};

const safeSendPlain = async (chatId, message, label = 'Telegram') => {
  try {
    await sendTelegramPlain(chatId, message);
  } catch (error) {
    console.error(`[BOT] Falha ao enviar mensagem texto puro (${label}):`, error.message);
  }
};

const handleSignal = async (body) => {
  let signalDetails = '';
  let symbol = '';

  try {
    const { action, price, stopLoss, takeProfit } = body;
    symbol = getPayloadSymbol(body);

    if (!action || !symbol || !price || !stopLoss || !takeProfit) return;

    const tipo = action === 'buy' ? 'COMPRA \\(LONG\\)' : 'VENDA \\(SHORT\\)';
    const emoji = action === 'buy' ? '🟢' : '🔴';
    const built = buildSignalDetails(body);
    signalDetails = built.details;

    const vipMsg =
      `${emoji} *SINAL DE ${tipo}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${signalDetails}` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_Sinal gerado por IA_`;

    await safeSendMarkdown(telegramChatId, vipMsg, 'VIP');

    const openPosition = await getOpenPositionData(symbol);
    const newHoldSide = action === 'buy' ? 'long' : 'short';

    if (openPosition) {
      const currentHoldSide = openPosition.holdSide;

      if (currentHoldSide === newHoldSide) {
        const adminMsg =
          `⚠️ *SINAL IGNORADO \\(POSIÇÃO DUPLICADA\\)*\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `${signalDetails}` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `_Motivo: Já existe operação na mesma direção\\._`;

        await safeSendMarkdown(telegramAdminChatId, adminMsg, 'Admin duplicada');
        return;
      }

      const adminMsgReversao =
        `🔄 *REVERSÃO DE TENDÊNCIA DETECTADA*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Par:* ${escapeMarkdown(symbol)}\n` +
        `🔁 *Fechando posição anterior* para abrir nova posição em *${escapeMarkdown(getTradeDir(body))}*\\.`;

      await safeSendMarkdown(telegramAdminChatId, adminMsgReversao, 'Admin reversão');
      await closePosition(symbol, currentHoldSide);
      await sleep(2000);
    }

    await placeOrder(symbol, action, price, stopLoss, takeProfit);

    if (await getOpenPositionData(symbol)) {
      const adminMsg =
        `✅ *ORDEM EXECUTADA COM SUCESSO*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `${signalDetails}` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `_Status: Ordem automática protegida com TP/SL\\!_`;

      await safeSendMarkdown(telegramAdminChatId, adminMsg, 'Admin executada');
    }
  } catch (error) {
    const motivoErro = translateBitgetError(error.message);
    const plainMsg =
      `❌ ERRO AO EXECUTAR ORDEM\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Par: ${symbol || 'Desconhecido'}\n` +
      `Motivo: ${motivoErro}\n` +
      `━━━━━━━━━━━━━━━━━━━━`;

    await safeSendPlain(telegramAdminChatId, plainMsg, 'Admin erro');
  }
};

const handleCloseAlert = async (body) => {
  const symbol = getPayloadSymbol(body);
  const pair = escapeMarkdown(symbol);
  const timeframe = escapeMarkdown(String(body.timeframe || '-'));
  const tradeDir = escapeMarkdown(String(body.trade_dir || body.tradeDir || 'N/D'));
  const entryPrice = escapeMarkdown(formatNumber(body.entry_price, 6));
  const exitPrice = escapeMarkdown(formatNumber(body.exit_price, 6));
  const resultText = escapeMarkdown(String(body.result_text || '-'));
  const resultIcon = String(body.result_icon || 'ℹ️');
  const entryTime = escapeMarkdown(String(getEntryTime(body)));
  const exitTime = escapeMarkdown(String(getExitTime(body)));
  const placar = String(body.placar_str || '').replace('📊 *Placar Geral:* ', '').trim();
  const placarEscaped = escapeMarkdown(placar);

  if (symbol) {
    const openPosition = await getOpenPositionData(symbol);
    if (openPosition) {
      try {
        await closePosition(symbol, openPosition.holdSide);
        console.log('[BOT] Posição fechada via webhook de saída.');
      } catch (e) {
        console.error('[BOT] Erro ao tentar fechar posição no webhook:', e.message);
      }
    }
  }

  const exitMsg =
    `${resultIcon}\n━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 *Par:* ${pair}\n` +
    `⏱ *Timeframe:* ${timeframe}\n` +
    `🔄 *Operação:* ${tradeDir}\n` +
    `🕒 *Entrada:* ${entryTime}\n` +
    `🕓 *Saída:* ${exitTime}\n` +
    `💰 *Preço Entrada:* \`${entryPrice}\`\n` +
    `🏁 *Preço Saída:* \`${exitPrice}\`\n` +
    `💵 *Resultado:* ${resultText}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${placarEscaped}`;

  await safeSendMarkdown(telegramChatId, exitMsg, 'VIP fechamento');
  await safeSendMarkdown(telegramAdminChatId, exitMsg, 'Admin fechamento');

  if (body.reversal_info) {
    const reversalAdmin =
      `🔄 *FECHAMENTO POR REVERSÃO*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📌 *Par:* ${pair}\n` +
      `ℹ️ ${escapeMarkdown(String(body.reversal_info))}`;

    await safeSendMarkdown(telegramAdminChatId, reversalAdmin, 'Admin fechamento reversão');
  }
};

const handleVipReversalAlert = async (body) => {
  const pair = escapeMarkdown(getPayloadSymbol(body));
  const timeframe = escapeMarkdown(String(body.timeframe || '-'));
  const oldPosition = escapeMarkdown(String(body.old_position || '-'));
  const newSignal = escapeMarkdown(String(body.new_signal || '-'));
  const entryTime = escapeMarkdown(String(getEntryTime(body)));
  const customMessage = escapeMarkdown(String(body.message || 'Reversão confirmada.'));

  const vipReversalMsg =
    `🚨 *ALERTA DE REVERSÃO VIP*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 *Par:* ${pair}\n` +
    `⏱ *Timeframe:* ${timeframe}\n` +
    `📤 *Posição Anterior:* ${oldPosition}\n` +
    `📥 *Novo Sinal:* ${newSignal}\n` +
    `🕒 *Horário:* ${entryTime}\n\n` +
    `${customMessage}`;

  await safeSendMarkdown(telegramChatId, vipReversalMsg, 'VIP reversão');
  await safeSendMarkdown(telegramAdminChatId, vipReversalMsg, 'Admin reversão VIP');
};

app.post('/webhook-bot', async (req, res) => {
  try {
    const body = req.body || {};
    console.log('[BOT] Webhook recebido:', JSON.stringify(body));

    if (body.action === 'close' || (body.result_icon && body.placar_str)) {
      await handleCloseAlert(body);
    } else if (body.action === 'reversal_alert_vip') {
      await handleVipReversalAlert(body);
    } else if (body.action === 'buy' || body.action === 'sell') {
      await handleSignal(body);
    } else {
      console.log('[BOT] Ação ignorada:', body.action);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[BOT] Erro no webhook:', error);
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