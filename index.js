const express = require('express');
const axios   = require('axios');
const app     = express();

const { handleSignal, getState, getOpenPositions, getBalance } = require('./mexcBot');

app.use(express.json());
app.use(express.text({ type: '*/*' }));

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
    if (tf === 'D' || tf === '1D') return '1 Dia';
    if (tf === 'W')           return '1 Semana';
    return tf;
}

// ─── Rota Telegram (mensagens diretas de saída) ───────────────────────────────
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

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id:    TELEGRAM_CHAT_ID,
            text:       message,
            parse_mode: 'Markdown'
        });

        console.log('✅ Mensagem enviada:', message.substring(0, 60) + '...');
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('❌ Erro:', err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Rota Bot Bitget (sinais do TradingView) ──────────────────────────────────
app.post('/webhook-bot', async (req, res) => {
    try {
        const body = req.body;

        if (body && body.action && body.symbol && body.price) {
            console.log('[BOT] Sinal recebido:', JSON.stringify(body));

            const isLong   = body.action === 'buy';
            const emoji    = isLong ? '🟢' : '🔴';
            const tipo     = isLong ? 'COMPRA (LONG)' : 'VENDA (SHORT)';
            const pairName = body.symbol.replace('USDT', '');
            const tf       = formatTimeframe(body.timeframe);
            const wins     = body.wins   ?? '—';
            const losses   = body.losses ?? '—';
            const winRate  = body.winRate != null ? body.winRate + '%' : '—';

            const telegramMsg =
                `${emoji} *SINAL DE ${tipo}*\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📌 *Par:* ${body.symbol}\n` +
                `⏱ *Timeframe:* ${tf}\n` +
                `⚙️ *Alavancagem:* 5x a 10x\n\n` +
                `💰 *Entrada:* \`${body.price}\`\n\n` +
                `🎯 *Take Profit:* \`${body.takeProfit}\` (+${body.tpPct}%)\n` +
                `🛑 *Stop Loss:* \`${body.stopLoss}\` (-${body.slPct}%)\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 *Placar:* ${wins}W - ${losses}L (${winRate})\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🔗 Operar na Bitget: [Clique aqui](https://www.bitget.com/futures/usdt/${pairName}USDT?inviteCode=KDY8LN6G)`;

            try {
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    chat_id:    TELEGRAM_CHAT_ID,
                    text:       telegramMsg,
                    parse_mode: 'Markdown'
                });
                console.log('[BOT] Telegram enviado com sucesso');
            } catch (tgErr) {
                console.error('[BOT] Erro ao enviar Telegram:', tgErr.message);
            }

            const result = await handleSignal(body);
            console.log('[BOT] Resultado:', JSON.stringify(result));
            return res.json(result);
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