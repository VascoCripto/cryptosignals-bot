async function placeOrder({ symbol, side, price, stopLoss, takeProfit }) {
    const leverage = parseInt(process.env.LEVERAGE) || 5;
    const capital  = parseFloat(process.env.CAPITAL_PER_TRADE) || 10;
    const holdSide = side === 'buy' ? 'long' : 'short';

    await setLeverage(symbol, leverage, holdSide);

    const balance = await getBalance();
    const useUSDT = (balance * capital) / 100;
    const size    = ((useUSDT * leverage) / price).toFixed(4);

    console.log(`[BOT] Saldo: ${balance} USDT | Margem: ${useUSDT} | Size: ${size}`);

    if (parseFloat(size) <= 0) throw new Error(`Size inválido — saldo: ${balance} USDT`);

    const order = await request('POST', '/api/v2/mix/order/place-order', {
        symbol,
        productType: 'USDT-FUTURES',
        marginMode:  'isolated',
        marginCoin:  'USDT',
        size,
        side,
        tradeSide:   'open',
        orderType:   'market'
    });

    console.log('[BOT] Ordem enviada:', JSON.stringify(order));

    if (order.code === '00000') {
        await request('POST', '/api/v2/mix/order/place-tpsl-order', {
            symbol,
            productType:    'USDT-FUTURES',
            marginCoin:     'USDT',
            planType:       'loss_plan',
            triggerPrice:   String(stopLoss),
            triggerType:    'mark_price',
            executePrice:   '0',
            holdSide,
            size
        });

        await request('POST', '/api/v2/mix/order/place-tpsl-order', {
            symbol,
            productType:    'USDT-FUTURES',
            marginCoin:     'USDT',
            planType:       'profit_plan',
            triggerPrice:   String(takeProfit),
            triggerType:    'mark_price',
            executePrice:   '0',
            holdSide,
            size
        });
    }

    return order;
}