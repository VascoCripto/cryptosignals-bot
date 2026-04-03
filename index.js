const express = require('express');
const axios   = require('axios');
const app     = express();

const { handleSignal, getState, getOpenPositions, getBalance } = require('./mexcBot');

app.use(express.json());
app.use(express.text({ type: '*/*' }));

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Rota Telegram ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
    try {
        let message = '';

        if (typeof req.body === 'object' && req.body.message) {
            message = req.body.message;
        } else if (typeof req.body === 'string' && req.body.trim() !== '') {
            message = req.body;
        } else {
            console.log('Body recebido:', req.body);
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

// ─── Rota Bot MEXC ────────────────────────────────────────────────────────────
app.post('/webhook-bot', async (req, res) => {
    try {
        const result = await handleSignal(req.body);
        console.log('[BOT] Resultado:', JSON.stringify(result));
        return res.json(result);
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