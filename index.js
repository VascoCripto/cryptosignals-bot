const express = require('express');
const axios   = require('axios');
const app     = express();

const { handleSignal, getState, getOpenPositions, getBalance } = require('./mexcBot');

app.use(express.json());
app.use(express.text({ type: '*/*' }));

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id:    TELEGRAM_CHAT_ID,
        text:       text,
        parse_mode: 'Markdown'
    });
}

function formatTimeframe(tf) {
    if (!tf) return '—';
    if (tf === '1')           return '1min';
    if (tf === '3')           return '3min';
    if (tf === '5')           return '5min';
    if (tf === '15')          return '15min';
    if (tf === '30')          return '30min';
    if (tf === '60')          return '1h';
    if (tf === '120')         return '2h';
    if (tf === '240')         return '4h';
    if (tf === '360')         return '6h';
    if (tf === '480')         return '8h';
    if (tf === '720')         return '12h';
    if (tf === 'D' || tf === '1D') return '1D';
    if (tf === 'W' || tf === '1W') return '1W';
    if (tf === 'M' || tf === '1M') return '1M';
    return tf;
}

// ─── Rota Telegram (mensagens diretas) ───────────────────────────────────────
app.post('/webhook', async (req, res) => {
    try {
        let message = '';
        if (typeof req.body === 'object' && req.body.message) {
            message = req.body.message;
        } else if (typeof req.body === 'string' && req.body.trim() !== '') {
            message = req.body;
        } else {
            return res.status(400).json({ error: 'Mensagem vazia ou formato inválido' });
        }

        await sendTelegram(message);

        console.log('✅ Mensagem enviada:', message.substring(0, 60) + '...');
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('❌ Erro:', err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Rota Bot Bitget ──────────────────────────────────────────────────────────
app.post('/webhook-bot', async (req, res) => {
    try {
        const body = req.body;

        // ── Sinal de entrada JSON ─────────────────────────────────────────────
        if (typeof body === 'object' && body.action && body.symbol && body.price) {
            console.log('[BOT] Sinal de entrada JSON recebido:', JSON.stringify(body));

            const tipo        = body.action === 'buy' ? 'COMPRA (LONG) 🟢' : 'VENDA (SHORT) 🔴';
            const emoji       = body.action === 'buy' ? '🟢' : '🔴';
            const pairName    = body.symbol.replace('_', '');

            const tf          = body.timeframe ? formatTimeframe(body.timeframe) : '—';
            const wins        = body.wins ?? '—';
            const losses      = body.losses ?? '—';
            const winRate     = (body.winRate !== undefined && body.winRate !== null) ? `${body.winRate.toFixed(1)}%` : '—';
            const tpPct       = (body.tpPct !== undefined && body.tpPct !== null) ? `${body.tpPct.toFixed(1)}%` : '—';
            const slPct       = (body.slPct !== undefined && body.slPct !== null) ? `${body.slPct.toFixed(1)}%` : '—';


            const telegramMsg =
                `${emoji} *SINAL DE ${tipo}*\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📌 *Par:* ${body.symbol}\n` +
                `⏱ *Timeframe:* ${tf}\n` +
                `⚙️ *Alavancagem:* 5x a 10x\n\n` +
                `💰 *Entrada:* \`${body.price}\`\n\n` +
                `🎯 *Take Profit:* \`${body.takeProfit}\` (+${tpPct})\n` +
                `🛑 *Stop Loss:* \`${body.stopLoss}\` (-${slPct})\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 *Placar:* ${wins}W - ${losses}L (${winRate})\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🔗 Operar na Bitget: [Clique aqui](https://www.bitget.com/futures/usdt/${pairName}USDT?inviteCode=KDY8LN6G)`;

            try {
                await sendTelegram(telegramMsg);
                console.log('[BOT] Telegram de entrada enviado');
            } catch (tgErr) {
                console.error('[BOT] Erro ao enviar Telegram de entrada:', tgErr.message);
            }

            const result = await handleSignal(body);
            console.log('[BOT] Resultado da ordem:', JSON.stringify(result));
            return res.json(result);
        }

        // ── Mensagem de saída (TP/SL) em texto — encaminha pro Telegram ───────
        const textoMensagem = typeof body === 'string'
            ? body
            : (body?.message ?? null);

        if (textoMensagem && textoMensagem.trim() !== '') {
            console.log('[BOT] Mensagem de saída detectada, enviando ao Telegram...');
            try {
                await sendTelegram(textoMensagem);
                console.log('[BOT] Mensagem de saída enviada ao Telegram');
            } catch (tgErr) {
                console.error('[BOT] Erro ao enviar saída ao Telegram:', tgErr.message);
            }
            return res.status(200).json({ ok: true, status: 'exit_message_sent' });
        }

        console.log('[BOT] Payload ignorado:', JSON.stringify(body));
        return res.status(200).json({ ok: true, status: 'ignored' });

    } catch (err) {
        console.error('[BOT] Erro inesperado:', err.message);
        return res.status(500).json({ status: 'error', reason: err.message });
    }
});

// ─── Status do bot ────────────────────────────────────────────────────────────
app.get('/bot-status', async (req, res) => {
    const [positions, balance] = await Promise.all([
        getOpenPositions(),
        getBalance(),
    ]);
    return res.json({
        botState:      getState(),
        balanceUSDT:   balance,
        openPositions: positions,
    });
});

// ─── IP do servidor ───────────────────────────────────────────────────────────
app.get('/meu-ip', async (req, res) => {
    try {
        const r = await axios.get('https://api.ipify.org?format=json');
        res.json(r.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Bot activo ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));