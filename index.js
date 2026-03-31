require('dotenv').config()
const express = require('express')
const axios = require('axios')

const app = express()
app.use(express.json())

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID
const PORT = process.env.PORT || 3000

async function sendTelegram(message) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`
    await axios.post(url, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
    })
}

app.post('/webhook', async (req, res) => {
    try {
        const body = req.body
        const message = body.message || JSON.stringify(body)
        await sendTelegram(message)
        res.status(200).json({ status: 'ok' })
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error.message)
        res.status(500).json({ status: 'error', message: error.message })
    }
})

app.get('/', (req, res) => {
    res.send('Bot de alertas rodando!')
})

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`)
})