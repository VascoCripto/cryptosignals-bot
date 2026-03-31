const express = require('express');
const axios   = require('axios');
const app     = express();

app.use(express.json());
app.use(express.text({ type: '*/*' }));

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

app.get('/', (req, res) => res.send('Bot activo ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));