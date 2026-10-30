// Alert delivery only. There are deliberately no exchange clients, credentials,
// account queries, order handlers, or paths capable of executing a trade.
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '32kb' }));
const token = process.env.TELEGRAM_BOT_TOKEN;
const userChat = process.env.TELEGRAM_CHAT_ID;
const adminChat = process.env.TELEGRAM_ADMIN_CHAT_ID || userChat;
const webhookSecret = process.env.WEBHOOK_SECRET;
const bot = token ? new TelegramBot(token, { polling: false }) : null;
const version = 'alerts-only-2026-10-30';
const processed = new Map();
let queue = Promise.resolve();

const symbolOf = b => String(b.symbol || b.pair_name || '').replace(/_/g, '').toUpperCase();
const direction = value => ({ BUY: 'LONG', SELL: 'SHORT', LONG: 'LONG', SHORT: 'SHORT' })[String(value || '').toUpperCase()] || null;
const number = v => Number.isFinite(Number(v)) && Number(v) > 0 ? String(Number(v)) : 'não informado';
const text = v => String(v ?? 'não informado').slice(0,250);
const sameSecret = value => {
  if (!webhookSecret) return true; // Optional for compatibility with existing TradingView alerts.
  const a=Buffer.from(String(value || '')),b=Buffer.from(webhookSecret);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
};
const buildMessage = b => {
  const symbol=symbolOf(b);
  if(!/^[A-Z0-9]{4,30}$/.test(symbol))throw new Error('invalid-symbol');
  const tf=text(b.timeframe || b.interval);
  if(b.action==='buy'||b.action==='sell'){
    const side=b.action==='buy'?'LONG':'SHORT';
    if(!['price','stopLoss','takeProfit'].every(k=>Number.isFinite(Number(b[k]))&&Number(b[k])>0))throw new Error('invalid-levels');
    return [`${side==='LONG'?'🟢':'🔴'} SINAL DE ${side}`,'━━━━━━━━━━━━━━━━━━━━',`Par: ${symbol}`,`Período: ${tf}`,`Horário informado: ${text(b.entryTime||b.entry_time)}`,`Referência do sinal: ${number(b.price)}`,`Stop de referência: ${number(b.stopLoss)}`,`Alvo de referência: ${number(b.takeProfit)}`,'Somente alerta. Nenhuma ordem foi aberta ou alterada na corretora.'].join('\n');
  }
  if(b.action==='reversal_alert_vip'){
    const oldSide=direction(b.old_position),newSide=direction(b.new_signal);
    if(!oldSide||!newSide||oldSide===newSide)return null;
    return ['🔄 MUDANÇA DE DIREÇÃO INFORMADA',`Par: ${symbol} · ${tf}`,`${oldSide} → ${newSide}`,`Horário informado: ${text(b.entryTime||b.entry_time)}`,'Evento da estratégia. Nenhuma posição real foi fechada ou aberta.'].join('\n');
  }
  if(b.action==='close'||(b.result_icon&&b.placar_str)){
    return ['📋 SAÍDA INFORMADA PELA ESTRATÉGIA',`Par: ${symbol} · ${tf}`,`Direção: ${direction(b.trade_dir||b.tradeDir)||'não informada'}`,`Entrada: ${text(b.entryTime||b.entry_time)}`,`Saída: ${text(b.exitTime||b.exit_time)}`,`Preço de entrada informado: ${number(b.entry_price)}`,`Preço de saída informado: ${number(b.exit_price)}`,`Resultado informado: ${text(b.result_text)}`,`Placar informado: ${text(b.placar_str)}`,'Este resultado não confirma execução na corretora. Nenhuma ordem foi alterada.'].join('\n');
  }
  return null;
};

async function deliver(body){
  const message=buildMessage(body);if(!message)return {ignored:true,reason:'unsupported-or-invalid-reversal'};
  const fingerprint=crypto.createHash('sha256').update(message).digest('hex');
  const now=Date.now();for(const [key,value]of processed)if(now-value>300000)processed.delete(key);
  if(processed.has(fingerprint))return {duplicate:true};
  if(!bot||!userChat)throw new Error('telegram-not-configured');
  // Remember attempts so a network timeout cannot automatically resend a possibly delivered message.
  processed.set(fingerprint,now);while(processed.size>5000)processed.delete(processed.keys().next().value);
  const destinations=[...new Set([userChat,adminChat].filter(Boolean))];
  const outcomes=await Promise.allSettled(destinations.map(chat=>bot.sendMessage(chat,message,{disable_web_page_preview:true})));
  if(outcomes.some(x=>x.status==='rejected'))throw new Error('telegram-delivery-not-confirmed');
  return {sent:true,destinations:destinations.length};
}

app.post('/webhook-bot',async(req,res)=>{
  const body=req.body;
  if(!body||Array.isArray(body)||typeof body!=='object')return res.status(400).json({error:'invalid-payload'});
  if(!sameSecret(req.get('x-webhook-secret')||body.webhookSecret||body.secret))return res.status(401).json({error:'unauthorized'});
  try{
    const work=queue.then(()=>deliver(body));queue=work.catch(()=>{});
    const result=await work;return res.status(200).json({mode:'alerts-only',...result});
  }catch(error){
    const invalid=['invalid-symbol','invalid-levels'].includes(error.message);
    console.error('[BOT] Falha na validação ou entrega do alerta. Execução em corretora desativada.');
    return res.status(invalid?400:502).json({error:invalid?'invalid-signal':'telegram-delivery-not-confirmed',exchangeExecution:false});
  }
});
app.get('/',(req,res)=>res.status(200).json({status:'ok',mode:'alerts-only',exchangeExecution:false,version}));
const port=process.env.PORT||8080;
app.listen(port,()=>console.log(`[BOT] ${version} na porta ${port}. Somente alertas Telegram; sem execução em corretora.`));
