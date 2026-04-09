const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config(); // Para carregar as variáveis de ambiente do seu .env

// --- Configurações da Bitget (Certifique-se de que seu arquivo .env está configurado) ---
const bitgetApiKey = process.env.BITGET_API_KEY;
const bitgetApiSecret = process.env.BITGET_API_SECRET;
const bitgetApiPassphrase = process.env.BITGET_PASSPHRASE;
const bitgetApiUrl = 'https://api.bitget.com';

// --- Função para gerar a assinatura (HMAC SHA256) ---
const generateSignature = (timestamp, method, requestPath, body = '') => {
    const message = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', bitgetApiSecret).update(message).digest('base64');
};

// --- Função para fazer requisições autenticadas à Bitget ---
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
        console.error('Erro na requisição Bitget API:', errorDetails);
        throw new Error(errorDetails);
    }
};

// --- Função para obter saldo disponível na conta de futuros (com tentativas de endpoints) ---
const getAvailableBalanceTest = async () => {
    const endpoints = [
        // NOVO ENDPOINT (o correto para todos os saldos de conta)
        '/api/v2/account/all-account-balance', 
        // Endpoint de futuros que falhou antes
        '/api/v2/mix/account/account-list?productType=USDT-FUTURES&marginCoin=USDT',
        // Endpoint de fundos que funcionou, mas não é o de futuros
        '/api/v2/account/funding-assets', 
        // Tentativas anteriores que falharam
        '/api/v2/mix/account/account-info?productType=USDT-FUTURES&marginCoin=USDT',
        '/api/v2/mix/account/account?productType=USDT-FUTURES&marginCoin=USDT',
        '/api/v2/mix/account/account-list?productType=USDT-FUTURES', 
        '/api/v2/mix/account/account-list', 
        '/api/v2/asset/v1/private/account/assets'
    ];

    for (const endpoint of endpoints) {
        console.log(`\nTentando endpoint: ${endpoint}`);
        try {
            const response = await bitgetRequest('GET', endpoint);
            console.log('Resposta da API:', JSON.stringify(response, null, 2));

            // Lógica para extrair saldo do formato com accountType: "futures"
            if (response && response.data && Array.isArray(response.data)) {
                const futuresAccount = response.data.find(acc => acc.accountType === 'futures');
                if (futuresAccount && futuresAccount.usdtBalance !== undefined) {
                    console.log(`Saldo disponível na conta de futuros encontrado para ${endpoint}: ${parseFloat(futuresAccount.usdtBalance)} USDT`);
                    return parseFloat(futuresAccount.usdtBalance);
                }
            }
            // Lógica para extrair saldo de outros formatos (mantida para compatibilidade, mas menos provável de ser usada agora)
            else if (endpoint.includes('/api/v2/mix/account/account-list')) {
                if (response && response.data && response.data.length > 0) {
                    const usdtFuturesAccount = response.data.find(acc => acc.productType === 'USDT-FUTURES' && acc.marginCoin === 'USDT');
                    if (usdtFuturesAccount) {
                        console.log(`Saldo disponível encontrado para ${endpoint}: ${parseFloat(usdtFuturesAccount.available)} USDT`);
                        return parseFloat(usdtFuturesAccount.available);
                    }
                }
            } else if (endpoint === '/api/v2/account/funding-assets') {
                if (response && response.data && response.data.length > 0) {
                    const usdtAsset = response.data.find(asset => asset.coin === 'USDT');
                    if (usdtAsset) {
                        console.log(`Saldo disponível encontrado para ${endpoint}: ${parseFloat(usdtAsset.available)} USDT`);
                        return parseFloat(usdtAsset.available);
                    }
                }
            } else if (endpoint.includes('account-info') || endpoint.includes('account?')) {
                if (response && response.data) {
                    console.log(`Saldo disponível encontrado para ${endpoint}: ${parseFloat(response.data.available)} USDT`);
                    return parseFloat(response.data.available);
                }
            } else if (endpoint.includes('/api/v2/asset/v1/private/account/assets')) {
                if (response && response.data && response.data.length > 0) {
                    const usdtAsset = response.data.find(asset => asset.coin === 'USDT');
                    if (usdtAsset) {
                        console.log(`Ativo USDT encontrado para ${endpoint}:`);
                        console.log(`  Total: ${parseFloat(usdtAsset.totalAmount)} USDT`);
                        console.log(`  Disponível: ${parseFloat(usdtAsset.availableAmount)} USDT`);
                        return parseFloat(usdtAsset.availableAmount);
                    }
                }
            }
            console.log(`Nenhum saldo USDT-FUTURES encontrado na resposta para ${endpoint}.`);

        } catch (error) {
            console.error(`Erro ao tentar ${endpoint}: ${error.message}`);
        }
    }
    console.log('\nNenhum endpoint conseguiu retornar o saldo disponível da conta USDT-FUTURES.');
    return 0;
};

// --- Executar o teste ---
(async () => {
    console.log('Iniciando teste de consulta de saldo da Bitget...');
    const balance = await getAvailableBalanceTest();
    console.log(`\nResultado final do teste: Saldo disponível na Bitget: ${balance} USDT`);
})();