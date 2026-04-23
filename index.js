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

const PRODUCT_TYPE = 'USDT-FUTURES';
const MARGIN_COIN = 'USDT';

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
  await bot.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true
  });
};

const sendTelegramPlain = async (chatId, text) => {
  await bot.sendMessage(chatId, text, {
    disable_web_page_preview: true
  });
};

const safeSendMarkdown = async (chatId, text) => {
  try {
    await sendTelegramMarkdown(chatId, text);
  } catch (error) {
    console.error('[BOT] Falha Telegram Markdown:', error.message);
  }
};

const safeSendPlain = async (chatId, text) => {
  try {
    await sendTelegramPlain(chatId, text);
  } catch (error) {
    console.error('[BOT] Falha Telegram texto puro:', error.message);
  }
};

const formatNumber = (value, decimals = 4) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? '-');
  return num.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

const normalizeSymbol = (raw) => String(raw || '').replace(/_/g, '').toUpperCase();
const getPayloadSymbol = (body) => normalizeSymbol(body.symbol || body.pair_name);
const getTradeDir = (body) =>
  body.tradeDir ||
  body.trade_dir ||
  (body.action === 'buy' ? 'LONG' : body.action === 'sell' ? 'SHORT' : 'N/D');
const getEntryTime = (body) => body.entryTime || body.entry_time || '-';
const getExitTime = (body) => body.exitTime || body.exit_time || '-';

const getLeverageForSymbol = (symbol) => {
  if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE') || symbol.includes('ICP') || symbol.includes('TRX')) return 5;
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

    const config = {
      method,
      url: `${bitgetApiUrl}${requestPath}`,
      headers
    };

    if (method !== 'GET') config.data = body;

    const response = await axios(config);
    return response.data;
  } catch (error) {
    const errorDetails = error.response && error.response.data
      ? JSON.stringify(error.response.data)
      : error.message;

    console.error('[BOT] Erro Bitget API:', errorDetails);
    throw new Error(errorDetails);
  }
};

const validateNumeric = (value, label) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${label} inválido: ${value}`);
  }
  return num;
};

const roundDown = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.floor(Number(value) * factor) / factor;
};

const roundUp = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.ceil(Number(value) * factor) / factor;
};

const roundNearest = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
};

const fallbackSymbolRules = {
  BTCUSDT: { priceDecimals: 2, triggerDecimals: 2, sizeDecimals: 3, minSize: 0.001 },
  ETHUSDT: { priceDecimals: 2, triggerDecimals: 2, sizeDecimals: 2, minSize: 0.01 },
  SOLUSDT: { priceDecimals: 3, triggerDecimals: 3, sizeDecimals: 1, minSize: 0.1 },
  ZECUSDT: { priceDecimals: 2, triggerDecimals: 2, sizeDecimals: 2, minSize: 0.01 },
  SUIUSDT: { priceDecimals: 4, triggerDecimals: 4, sizeDecimals: 1, minSize: 0.1 },
  AVAXUSDT: { priceDecimals: 2, triggerDecimals: 2, sizeDecimals: 2, minSize: 0.01 },
  XRPUSDT: { priceDecimals: 4, triggerDecimals: 4, sizeDecimals: 0, minSize: 1 },
  ADAUSDT: { priceDecimals: 4, triggerDecimals: 4, sizeDecimals: 0, minSize: 1 },
  DOTUSDT: { priceDecimals: 3, triggerDecimals: 3, sizeDecimals: 1, minSize: 0.1 },
  BGBUSDT: { priceDecimals: 4, triggerDecimals: 4, sizeDecimals: 1, minSize: 0.1 },
  ICPUSDT: { priceDecimals: 3, triggerDecimals: 3, sizeDecimals: 1, minSize: 0.1 },
  TRXUSDT: { priceDecimals: 4, triggerDecimals: 4, sizeDecimals: 0, minSize: 1 },
  LINKUSDT: { priceDecimals: 3, triggerDecimals: 3, sizeDecimals: 2, minSize: 0.01 },
  UNIUSDT: { priceDecimals: 3, triggerDecimals: 3, sizeDecimals: 2, minSize: 0.01 },
  ETCUSDT: { priceDecimals: 2, triggerDecimals: 2, sizeDecimals: 2, minSize: 0.01 },
  ATOMUSDT: { priceDecimals: 3, triggerDecimals: 3, sizeDecimals: 2, minSize: 0.01 },
  NEARUSDT: { priceDecimals: 3, triggerDecimals: 3, sizeDecimals: 2, minSize: 0.01 }
};

const symbolConfigCache = new Map();

const getFallbackRuleByPattern = (symbol) => {
  if (fallbackSymbolRules[symbol]) return fallbackSymbolRules[symbol];

  if (symbol.includes('BTC')) return { priceDecimals: 2, triggerDecimals: 2, sizeDecimals: 3, minSize: 0.001 };
  if (symbol.includes('ETH')) return { priceDecimals: 2, triggerDecimals: 2, sizeDecimals: 2, minSize: 0.01 };
  if (symbol.includes('SOL')) return { priceDecimals: 3, triggerDecimals: 3, sizeDecimals: 1, minSize: 0.1 };
  if (symbol.includes('XRP') || symbol.includes('ADA') || symbol.includes('DOGE') || symbol.includes('TRX')) {
    return { priceDecimals: 4, triggerDecimals: 4, sizeDecimals: 0, minSize: 1 };
  }

  return { priceDecimals: 3, triggerDecimals: 3, sizeDecimals: 2, minSize: 0.01 };
};

const getAllBitgetContracts = async () => {
  try {
    const response = await bitgetRequest('GET', `/api/v2/mix/market/contracts?productType=${PRODUCT_TYPE}`);
    return Array.isArray(response?.data) ? response.data : [];
  } catch (error) {
    console.error('[BOT] Falha ao buscar contratos:', error.message);
    return [];
  }
};

const getSymbolRuntimeConfig = async (symbol) => {
  const normalized = normalizeSymbol(symbol);

  if (symbolConfigCache.has(normalized)) {
    return symbolConfigCache.get(normalized);
  }

  const fallback = getFallbackRuleByPattern(normalized);

  try {
    const contracts = await getAllBitgetContracts();
    const found = contracts.find(item => normalizeSymbol(item.symbol) === normalized);

    if (!found) {
      symbolConfigCache.set(normalized, fallback);
      return fallback;
    }

    const priceDecimals =
      Number.isInteger(Number(found.pricePlace)) ? Number(found.pricePlace)
      : Number.isInteger(Number(found.priceEndStep)) ? Number(found.priceEndStep)
      : fallback.priceDecimals;

    const triggerDecimals =
      Number.isInteger(Number(found.pricePlace)) ? Number(found.pricePlace)
      : fallback.triggerDecimals;

    let sizeDecimals = fallback.sizeDecimals;

    const sizeMultiplier = String(found.sizeMultiplier ?? '');
    if (sizeMultiplier.includes('.')) {
      sizeDecimals = Math.max(sizeMultiplier.split('.')[1].replace(/0+$/, '').length, 0);
    } else if (Number.isInteger(Number(found.volumePlace))) {
      sizeDecimals = Number(found.volumePlace);
    }

    const minSize = Number(found.minTradeNum || found.minTradeAmount || fallback.minSize) || fallback.minSize;

    const config = {
      priceDecimals,
      triggerDecimals,
      sizeDecimals,
      minSize
    };

    symbolConfigCache.set(normalized, config);
    return config;
  } catch (error) {
    symbolConfigCache.set(normalized, fallback);
    return fallback;
  }
};

const normalizePrice = (value, decimals) => roundNearest(value, decimals);
const normalizeTrigger = (value, decimals, direction = 'nearest') => {
  if (direction === 'down') return roundDown(value, decimals);
  if (direction === 'up') return roundUp(value, decimals);
  return roundNearest(value, decimals);
};

const normalizeSize = (value, decimals, minSize = 0) => {
  const rounded = roundDown(value, decimals);
  const finalValue = Math.max(rounded, Number(minSize || 0));
  return Number(finalValue.toFixed(decimals));
};

const getAvailableBalance = async () => {
  try {
    const response = await bitgetRequest(
      'GET',
      `/api/v2/mix/account/account?productType=${PRODUCT_TYPE}&marginCoin=${MARGIN_COIN}`
    );

    if (response && response.data) {
      const accountData = Array.isArray(response.data) ? response.data[0] : response.data;
      if (accountData && accountData.available !== undefined) {
        return parseFloat(accountData.available);
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
      `/api/v2/mix/position/single-position?symbol=${symbol}&productType=${PRODUCT_TYPE}&marginCoin=${MARGIN_COIN}`
    );

    if (response && response.data && Array.isArray(response.data)) {
      const positions = response.data.filter(
        pos => normalizeSymbol(pos.symbol) === normalizeSymbol(symbol) && parseFloat(pos.total) > 0
      );
      if (positions.length > 0) return positions[0];
    }

    return null;
  } catch (error) {
    return null;
  }
};

const getMarkPrice = async (symbol) => {
  try {
    const response = await bitgetRequest(
      'GET',
      `/api/v2/mix/market/ticker?symbol=${symbol}&productType=${PRODUCT_TYPE}`
    );

    const ticker = Array.isArray(response?.data) ? response.data[0] : response?.data;
    const candidates = [ticker?.markPrice, ticker?.lastPr, ticker?.last, ticker?.price];

    for (const candidate of candidates) {
      const num = Number(candidate);
      if (Number.isFinite(num) && num > 0) return num;
    }

    return null;
  } catch (error) {
    console.error('[BOT] Erro ao buscar mark price:', error.message);
    return null;
  }
};

const setLeverage = async (symbol, leverage, holdSide) => {
  try {
    await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
      symbol,
      productType: PRODUCT_TYPE,
      marginCoin: MARGIN_COIN,
      leverage: leverage.toString(),
      holdSide
    });
  } catch (error) {
    console.log(`[BOT] Aviso ao ajustar alavancagem: ${error.message}`);
  }
};

const closePosition = async (symbol, holdSide) => {
  try {
    await bitgetRequest('POST', '/api/v2/mix/order/close-positions', {
      symbol,
      productType: PRODUCT_TYPE,
      marginCoin: MARGIN_COIN,
      holdSide
    });
    console.log(`[BOT] Posição ${symbol} (${holdSide}) fechada.`);
  } catch (error) {
    throw new Error(`Falha ao fechar posição: ${error.message}`);
  }
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
  } else if (motivoErro.includes('40917') || motivoErro.includes('Stop price for long positions please < mark price')) {
    motivoErro = 'Stop loss inválido para LONG: ele precisa estar abaixo do preço de marca.';
  } else if (motivoErro.includes('Stop price for short positions please > mark price')) {
    motivoErro = 'Stop loss inválido para SHORT: ele precisa estar acima do preço de marca.';
  } else if (motivoErro.includes('40808') || motivoErro.includes('checkBDScale')) {
    motivoErro = 'Preço enviado com casas decimais inválidas para este ativo na Bitget.';
  }

  return motivoErro;
};

const prepareProtectedPrices = async ({ symbol, action, entryPrice, stopLoss, takeProfit }) => {
  const cfg = await getSymbolRuntimeConfig(symbol);
  const entry = validateNumeric(entryPrice, 'Preço de entrada');
  let sl = validateNumeric(stopLoss, 'Stop Loss');
  let tp = validateNumeric(takeProfit, 'Take Profit');
  const mark = await getMarkPrice(symbol);

  const normalizedEntry = normalizePrice(entry, cfg.priceDecimals);

  if (action === 'buy') {
    if (sl >= normalizedEntry) sl = normalizedEntry * 0.995;
    if (tp <= normalizedEntry) tp = normalizedEntry * 1.005;
    if (Number.isFinite(mark) && sl >= mark) sl = mark * 0.995;
    if (Number.isFinite(mark) && tp <= mark) tp = Math.max(tp, mark * 1.005);

    sl = normalizeTrigger(sl, cfg.triggerDecimals, 'down');
    tp = normalizeTrigger(tp, cfg.triggerDecimals, 'up');

    if (!(sl < normalizedEntry)) throw new Error('SL inválido para LONG após normalização.');
    if (!(tp > normalizedEntry)) throw new Error('TP inválido para LONG após normalização.');
    if (Number.isFinite(mark) && !(sl < mark)) throw new Error('SL inválido para LONG em relação ao mark price.');
  } else {
    if (sl <= normalizedEntry) sl = normalizedEntry * 1.005;
    if (tp >= normalizedEntry) tp = normalizedEntry * 0.995;
    if (Number.isFinite(mark) && sl <= mark) sl = mark * 1.005;
    if (Number.isFinite(mark) && tp >= mark) tp = Math.min(tp, mark * 0.995);

    sl = normalizeTrigger(sl, cfg.triggerDecimals, 'up');
    tp = normalizeTrigger(tp, cfg.triggerDecimals, 'down');

    if (!(sl > normalizedEntry)) throw new Error('SL inválido para SHORT após normalização.');
    if (!(tp < normalizedEntry)) throw new Error('TP inválido para SHORT após normalização.');
    if (Number.isFinite(mark) && !(sl > mark)) throw new Error('SL inválido para SHORT em relação ao mark price.');
  }

  return {
    config: cfg,
    entryPrice: normalizedEntry,
    stopLoss: sl,
    takeProfit: tp,
    markPrice: mark
  };
};

const calculateOrderSize = async (symbol, price) => {
  const cfg = await getSymbolRuntimeConfig(symbol);
  const leverage = getLeverageForSymbol(symbol);
  const marginToUse = 10;

  let size = (marginToUse * leverage) / Number(price);
  size = normalizeSize(size, cfg.sizeDecimals, cfg.minSize);

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Size calculado inválido para ${symbol}`);
  }

  return {
    size: size.toFixed(cfg.sizeDecimals),
    config: cfg
  };
};

const placeEntryOrder = async (symbol, action, price) => {
  const side = action === 'buy' ? 'buy' : 'sell';
  const holdSide = action === 'buy' ? 'long' : 'short';
  const leverage = getLeverageForSymbol(symbol);
  const cfg = await getSymbolRuntimeConfig(symbol);
  const normalizedPrice = normalizePrice(price, cfg.priceDecimals);

  await setLeverage(symbol, leverage, holdSide);
  await getAvailableBalance();

  const sizeInfo = await calculateOrderSize(symbol, normalizedPrice);

  await bitgetRequest('POST', '/api/v2/mix/order/place-order', {
    symbol,
    productType: PRODUCT_TYPE,
    marginMode: 'isolated',
    marginCoin: MARGIN_COIN,
    size: sizeInfo.size.toString(),
    price: String(normalizedPrice),
    side,
    orderType: 'market',
    holdSide,
    tradeSide: 'open'
  });

  return {
    holdSide,
    leverage,
    size: sizeInfo.size,
    config: sizeInfo.config,
    normalizedPrice
  };
};

const placePositionTpsl = async (symbol, holdSide, stopLoss, takeProfit) => {
  return bitgetRequest('POST', '/api/v2/mix/order/place-pos-tpsl', {
    symbol,
    productType: PRODUCT_TYPE,
    marginCoin: MARGIN_COIN,
    holdSide,
    stopSurplusTriggerPrice: String(takeProfit),
    stopSurplusTriggerType: 'mark_price',
    stopLossTriggerPrice: String(stopLoss),
    stopLossTriggerType: 'mark_price'
  });
};

const ensureProtectedPosition = async ({ symbol, action, entryPrice, stopLoss, takeProfit, holdSide }) => {
  let lastError = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await sleep(attempt === 1 ? 1500 : 2500);

      const prepared = await prepareProtectedPrices({
        symbol,
        action,
        entryPrice,
        stopLoss,
        takeProfit
      });

      await placePositionTpsl(
        symbol,
        holdSide,
        prepared.stopLoss,
        prepared.takeProfit
      );

      await sleep(1200);

      return {
        ok: true,
        stopLoss: prepared.stopLoss,
        takeProfit: prepared.takeProfit,
        markPrice: prepared.markPrice,
        config: prepared.config
      };
    } catch (error) {
      lastError = error;
      console.error(`[BOT] Tentativa ${attempt} TP/SL falhou:`, error.message);
      await sleep(900);
    }
  }

  return { ok: false, error: lastError };
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
      `${emoji} *SINAL DE ${tipo}*\n━━━━━━━━━━━━━━━━━━━━\n${signalDetails}━━━━━━━━━━━━━━━━━━━━\n_Sinal automatizado_`;

    await safeSendMarkdown(telegramChatId, vipMsg);

    const openPosition = await getOpenPositionData(symbol);
    const newHoldSide = action === 'buy' ? 'long' : 'short';

    if (openPosition) {
      const currentHoldSide = openPosition.holdSide;

      if (currentHoldSide === newHoldSide) {
        const adminMsg =
          `⚠️ *SINAL IGNORADO \\(POSIÇÃO DUPLICADA\\)*\n━━━━━━━━━━━━━━━━━━━━\n${signalDetails}━━━━━━━━━━━━━━━━━━━━\n_Motivo: Já existe operação na mesma direção\\._`;
        await safeSendMarkdown(telegramAdminChatId, adminMsg);
        return;
      }

      const adminMsgReversao =
        `🔄 *REVERSÃO DE TENDÊNCIA DETECTADA*\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Par:* ${escapeMarkdown(symbol)}\n` +
        `🔁 *Fechando posição anterior* para abrir nova posição em *${escapeMarkdown(getTradeDir(body))}*\\.`;

      await safeSendMarkdown(telegramAdminChatId, adminMsgReversao);
      await closePosition(symbol, currentHoldSide);
      await sleep(2500);
    }

    validateNumeric(price, 'Preço');
    validateNumeric(stopLoss, 'Stop Loss');
    validateNumeric(takeProfit, 'Take Profit');

    const entryResult = await placeEntryOrder(symbol, action, Number(price));
    await sleep(2000);

    const confirmedPosition = await getOpenPositionData(symbol);
    if (!confirmedPosition) {
      throw new Error('A ordem foi enviada, mas a posição não pôde ser confirmada na Bitget.');
    }

    const protection = await ensureProtectedPosition({
      symbol,
      action,
      entryPrice: entryResult.normalizedPrice,
      stopLoss: Number(stopLoss),
      takeProfit: Number(takeProfit),
      holdSide: entryResult.holdSide
    });

    if (!protection.ok) {
      await safeSendPlain(
        telegramAdminChatId,
        `⚠️ PROTEÇÃO NÃO CONFIRMADA EM ${symbol}. Fechamento emergencial acionado.`
      );

      await closePosition(symbol, entryResult.holdSide);
      await sleep(1500);

      throw new Error(`Falha crítica ao configurar TP/SL. Posição encerrada por segurança. Detalhe: ${protection.error?.message || 'Erro desconhecido'}`);
    }

    const adminMsg =
      `✅ *ORDEM EXECUTADA E PROTEGIDA*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `${signalDetails}` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🛡 *Proteção confirmada*\n` +
      `🎯 *TP ativo:* \`${escapeMarkdown(formatNumber(protection.takeProfit, 6))}\`\n` +
      `🛑 *SL ativo:* \`${escapeMarkdown(formatNumber(protection.stopLoss, 6))}\`\n` +
      `_Status: Ordem automática protegida com redundância\\._`;

    await safeSendMarkdown(telegramAdminChatId, adminMsg);
  } catch (error) {
    const motivoErro = translateBitgetError(error.message);
    const plainMsg =
      `❌ ERRO AO EXECUTAR ORDEM\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Par: ${symbol || 'Desconhecido'}\n` +
      `Motivo: ${motivoErro}\n` +
      `━━━━━━━━━━━━━━━━━━━━`;

    await safeSendPlain(telegramAdminChatId, plainMsg);
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

  await safeSendMarkdown(telegramChatId, exitMsg);
  await safeSendMarkdown(telegramAdminChatId, exitMsg);

  if (body.reversal_info) {
    const reversalAdmin =
      `🔄 *FECHAMENTO POR REVERSÃO*\n━━━━━━━━━━━━━━━━━━━━\n📌 *Par:* ${pair}\nℹ️ ${escapeMarkdown(String(body.reversal_info))}`;

    await safeSendMarkdown(telegramAdminChatId, reversalAdmin);
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
    `🚨 *ALERTA DE REVERSÃO VIP*\n━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 *Par:* ${pair}\n` +
    `⏱ *Timeframe:* ${timeframe}\n` +
    `📤 *Posição Anterior:* ${oldPosition}\n` +
    `📥 *Novo Sinal:* ${newSignal}\n` +
    `🕒 *Horário:* ${entryTime}\n\n` +
    `${customMessage}`;

  await safeSendMarkdown(telegramChatId, vipReversalMsg);
  await safeSendMarkdown(telegramAdminChatId, vipReversalMsg);
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