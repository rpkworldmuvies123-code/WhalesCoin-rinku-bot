require('dotenv').config();

const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const sharp = require('sharp');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 10000);
const BRAND_NAME = process.env.BRAND_NAME || 'WhalesCoin';
const WEBSITE_URL = process.env.WEBSITE_URL || '';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'whalescoin-secure-webhook';
const OWNER_ID = String(process.env.BOT_OWNER_ID || '').trim();
const OWNER_USERNAME = String(process.env.BOT_OWNER_USERNAME || '').replace(/^@/, '').toLowerCase().trim();
const STAFF_USERNAMES = new Set(
  String(process.env.BOT_ADMIN_USERNAMES || '')
    .split(',')
    .map(v => v.replace(/^@/, '').toLowerCase().trim())
    .filter(Boolean)
);

const ALLOWED_DOMAINS = String(process.env.ALLOWED_DOMAINS || '')
  .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
const EXTRA_BLOCKED_WORDS = String(process.env.BLOCKED_WORDS || '')
  .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN environment variable.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const api = axios.create({ baseURL: 'https://api.coinpaprika.com/v1', timeout: 12000 });

// Memory-only state. It resets when Render restarts.
const floodMap = new Map();
const violationMap = new Map();
const watchMap = new Map();
const pendingSearch = new Map();
const messageState = new Map();
const groupStats = new Map();

const DEFAULT_BLOCKED_WORDS = [
  'scam link', 'free usdt', 'guaranteed profit', 'double your money',
  'dm for investment', 'send crypto to', 'wallet verification fee'
];
const blockedWords = [...DEFAULT_BLOCKED_WORDS, ...EXTRA_BLOCKED_WORDS];

const URL_REGEX = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|[a-z0-9-]+\.(?:com|net|org|io|co|in|xyz|me|app|site|online|shop|info|biz|link|live|pro|ai)(?:\/|\b))/i;

function esc(v = '') {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function userLabel(u) {
  if (!u) return 'Member';
  if (u.username) return '@' + esc(u.username);
  return `<a href="tg://user?id=${u.id}">${esc(u.first_name || 'Member')}</a>`;
}
function fmtMoney(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'N/A';
  const n = Number(v);
  if (Math.abs(n) >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 12 });
}
function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'N/A';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function pct(v) { const n = Number(v || 0); return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function iconFor(v) { return Number(v || 0) >= 0 ? '🟢' : '🔴'; }
function coinTitle(c) { return `${esc(c?.name || 'Unknown')} <code>${esc(c?.symbol || '')}</code>`; }
function nowLabel() { return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); }
function normalize(q) { return String(q || '').trim().replace(/^\$/, '').toUpperCase(); }
function key(chatId, userId, coinId) { return `${chatId}:${userId}:${coinId}`; }

async function send(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML', disable_web_page_preview: true, ...opts
    });
  } catch (e) { console.log('send:', e.message); return null; }
}
async function answer(queryId, text = '', alert = false) {
  try { await bot.answerCallbackQuery(queryId, { text, show_alert: alert }); } catch {}
}
async function isGroupAdmin(chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(m.status);
  } catch { return false; }
}
function isBotStaff(user) {
  if (!user) return false;
  if (OWNER_ID && String(user.id) === OWNER_ID) return true;
  if (OWNER_USERNAME && String(user.username || '').toLowerCase() === OWNER_USERNAME) return true;
  return STAFF_USERNAMES.has(String(user.username || '').toLowerCase());
}
function staffRole(user) {
  if (!user) return 'USER';
  if ((OWNER_ID && String(user.id) === OWNER_ID) || (OWNER_USERNAME && String(user.username || '').toLowerCase() === OWNER_USERNAME)) return 'OWNER';
  if (STAFF_USERNAMES.has(String(user.username || '').toLowerCase())) return 'SUPER ADMIN';
  return 'USER';
}
function normalizeText(msg) { return `${msg.text || ''} ${msg.caption || ''}`.trim(); }
function containsBlocked(text) { const t = String(text || '').toLowerCase(); return blockedWords.some(w => w && t.includes(w)); }
function domains(text) {
  const matches = String(text || '').match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi) || [];
  return matches.map(raw => {
    try { return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase(); }
  });
}
function allowedUrl(text) {
  if (!URL_REGEX.test(text || '')) return true;
  if (!ALLOWED_DOMAINS.length) return false;
  return domains(text).every(d => ALLOWED_DOMAINS.some(a => d === a || d.endsWith(`.${a}`)));
}
async function del(chatId, messageId) { try { await bot.deleteMessage(chatId, messageId); } catch {} }
async function ban(chatId, userId) { try { await bot.banChatMember(chatId, userId); return true; } catch (e) { console.log('ban:', e.message); return false; } }
async function restrict(chatId, userId, seconds = 600) {
  try {
    await bot.restrictChatMember(chatId, userId, {
      permissions: {
        can_send_messages: false, can_send_audios: false, can_send_documents: false,
        can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
        can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
        can_add_web_page_previews: false, can_change_info: false, can_invite_users: false,
        can_pin_messages: false, can_manage_topics: false
      }, until_date: Math.floor(Date.now() / 1000) + seconds
    });
    return true;
  } catch (e) { console.log('restrict:', e.message); return false; }
}
function flood(chatId, userId) {
  const k = `${chatId}:${userId}`, now = Date.now(), old = floodMap.get(k) || [];
  const recent = old.filter(t => now - t < 10000); recent.push(now); floodMap.set(k, recent);
  return recent.length > 7;
}
function violation(chatId, userId) {
  const k = `${chatId}:${userId}`, n = (violationMap.get(k) || 0) + 1; violationMap.set(k, n); return n;
}

async function searchCoin(q) {
  try {
    const { data } = await api.get('/search', { params: { q: String(q).trim(), c: 'currencies' } });
    const list = data?.currencies || [], t = normalize(q);
    return list.find(c => String(c.symbol || '').toUpperCase() === t) || list.find(c => String(c.id || '').toLowerCase() === String(q).toLowerCase()) || list[0] || null;
  } catch (e) { console.log('search:', e.message); return null; }
}
async function ticker(id) { const { data } = await api.get(`/tickers/${id}`); return data; }
async function info(id) { const { data } = await api.get(`/coins/${id}`); return data; }
async function markets(id) { const { data } = await api.get(`/coins/${id}/markets`, { params: { quotes: 'USD', limit: 8 } }); return Array.isArray(data) ? data : []; }

function mainMenu() {
  return { inline_keyboard: [
    [{ text: '📊 Markets', callback_data: 'ui:markets' }, { text: '🔥 Trending', callback_data: 'ui:trending' }],
    [{ text: '🔎 Search Coin', callback_data: 'ui:search' }, { text: '⭐ Watchlist', callback_data: 'ui:watchlist' }],
    [{ text: '📜 Rules', callback_data: 'ui:rules' }, { text: '🌐 Website', url: WEBSITE_URL || 'https://whalescoin.com' }]
  ]};
}
function backMenu() { return { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'ui:home' }]] }; }
function coinButtons(id) {
  return { inline_keyboard: [
    [{ text: '💰 Price', callback_data: `coin:price:${id}` }, { text: '📊 Market', callback_data: `coin:market:${id}` }],
    [{ text: '📈 Volume', callback_data: `coin:volume:${id}` }, { text: '💎 Supply', callback_data: `coin:supply:${id}` }],
    [{ text: 'ℹ️ About', callback_data: `coin:about:${id}` }, { text: '🔗 Links', callback_data: `coin:links:${id}` }],
    [{ text: '⭐ Add to Watchlist', callback_data: `coin:watch:${id}` }],
    [{ text: '🔄 Refresh', callback_data: `coin:refresh:${id}` }, { text: '⬅️ Back', callback_data: 'ui:home' }]
  ]};
}

function homeText() {
  return `🐋 <b>W H A L E S C O I N</b>\n\n<i>Your gateway to the crypto market.</i>\n\n━━━━━━━━━━━━━━━━━━\n📊 <b>LIVE MARKET</b>\n🔥 <b>TRENDING</b>\n🔎 <b>SEARCH COINS</b>\n⭐ <b>WATCHLIST</b>\n━━━━━━━━━━━━━━━━━━\n\n🟢 Market: <b>LIVE</b>\n⚡ Data: <b>Real-Time</b>\n🛡️ Moderation: <b>Active</b>\n\n<i>🐋 WhalesCoin • Live Market Data</i>`;
}
function homeKeyboard() { return mainMenu(); }

async function compactLogoBuffer(coin) {
  try {
    const logoUrl = `https://static.coinpaprika.com/coin/${coin.id}/logo.png`;
    const { data } = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 7000 });
    return await sharp(Buffer.from(data)).resize(110, 110, { fit: 'contain' }).png().toBuffer();
  } catch { return null; }
}

async function buildCoinVisual(coin, market) {
  const usd = market?.quotes?.USD || {};
  const change = Number(usd.percent_change_24h || 0);
  const logo = await compactLogoBuffer(coin);
  const logoData = logo ? `data:image/png;base64,${logo.toString('base64')}` : '';
  const title = esc(coin.name || market.name || 'Coin').replace(/&/g, '&amp;');
  const symbol = esc(coin.symbol || market.symbol || '');
  const price = esc(fmtMoney(usd.price));
  const ch = esc(pct(change));
  const mc = esc(fmtMoney(usd.market_cap));
  const vol = esc(fmtMoney(usd.volume_24h));
  const accent = change >= 0 ? '#39e58c' : '#ff5c72';
  const svg = `<svg width="900" height="300" viewBox="0 0 900 300" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0" x2="1"><stop stop-color="#07111c"/><stop offset="1" stop-color="#101b2a"/></linearGradient><linearGradient id="gold" x1="0" x2="1"><stop stop-color="#ffe27a"/><stop offset="1" stop-color="#d7a52e"/></linearGradient></defs>
  <rect width="900" height="300" rx="34" fill="url(#bg)"/><rect x="1" y="1" width="898" height="298" rx="34" fill="none" stroke="#caa33a" stroke-opacity=".45"/>
  ${logoData ? `<image href="${logoData}" x="42" y="42" width="110" height="110"/>` : `<circle cx="97" cy="97" r="55" fill="#172638" stroke="#d8ae3c"/><text x="97" y="108" text-anchor="middle" fill="#ffe27a" font-size="32" font-family="Arial" font-weight="700">🐋</text>`}
  <text x="180" y="72" fill="#f5f7fb" font-size="30" font-family="Arial" font-weight="700">${title}</text>
  <text x="180" y="106" fill="#8fa4bb" font-size="20" font-family="Arial">${symbol}  •  LIVE MARKET</text>
  <text x="42" y="208" fill="#ffffff" font-size="46" font-family="Arial" font-weight="700">${price}</text>
  <text x="42" y="242" fill="${accent}" font-size="23" font-family="Arial" font-weight="700">${ch}  24H</text>
  <rect x="455" y="42" width="200" height="92" rx="20" fill="#0c1927" stroke="#20364b"/><text x="475" y="72" fill="#8fa4bb" font-size="16" font-family="Arial">MARKET CAP</text><text x="475" y="108" fill="#f5f7fb" font-size="25" font-family="Arial" font-weight="700">${mc}</text>
  <rect x="675" y="42" width="185" height="92" rx="20" fill="#0c1927" stroke="#20364b"/><text x="695" y="72" fill="#8fa4bb" font-size="16" font-family="Arial">24H VOLUME</text><text x="695" y="108" fill="#f5f7fb" font-size="25" font-family="Arial" font-weight="700">${vol}</text>
  <text x="650" y="252" text-anchor="middle" fill="#d9b44a" font-size="17" font-family="Arial" font-weight="700">🐋 WHALESCOIN</text>
  </svg>`;
  return Buffer.from(svg);
}

function coinCaption(coin, market) {
  const usd = market?.quotes?.USD || {}, change = Number(usd.percent_change_24h || 0);
  return `🐋 <b>${coinTitle(coin)}</b>  <i>#${esc(coin.rank || market.rank || '—')}</i>\n\n💰 <b>${fmtMoney(usd.price)}</b>\n${iconFor(change)} <b>${pct(change)}</b> <i>24H</i>\n\n━━━━━━━━━━━━━━━━\n🏦 Market Cap  <b>${fmtMoney(usd.market_cap)}</b>\n📊 Volume      <b>${fmtMoney(usd.volume_24h)}</b>\n━━━━━━━━━━━━━━━━\n\n<i>Updated ${nowLabel()} • WhalesCoin Live Data</i>`;
}

async function sendCoinCard(chatId, coin, edit = null) {
  try {
    const market = await ticker(coin.id);
    const fullCoin = { ...coin, name: market?.name || coin.name, symbol: market?.symbol || coin.symbol, rank: market?.rank || coin.rank };
    const caption = coinCaption(fullCoin, market);
    const keyboard = coinButtons(coin.id);
    const visual = await buildCoinVisual(fullCoin, market);
    if (edit?.message_id && edit?.hasPhoto) {
      try {
        await bot.editMessageCaption(caption, { chat_id: chatId, message_id: edit.message_id, parse_mode: 'HTML', reply_markup: keyboard });
        messageState.set(`${chatId}:${edit.message_id}`, { coinId: coin.id, type: 'coin' });
        return;
      } catch {}
    }
    const sent = await bot.sendPhoto(chatId, visual, { caption, parse_mode: 'HTML', reply_markup: keyboard });
    if (sent?.message_id) messageState.set(`${chatId}:${sent.message_id}`, { coinId: coin.id, type: 'coin' });
    return sent;
  } catch (e) {
    console.log('coin card:', e.message);
    return send(chatId, '⚠️ Market data is temporarily unavailable. Please try again.');
  }
}

async function editScreen(query, text, keyboard = backMenu()) {
  const m = query.message;
  if (!m) return;
  try {
    if (m.photo) return await bot.editMessageCaption(text, { chat_id: m.chat.id, message_id: m.message_id, parse_mode: 'HTML', reply_markup: keyboard });
    return await bot.editMessageText(text, { chat_id: m.chat.id, message_id: m.message_id, parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
  } catch (e) { console.log('editScreen:', e.message); }
}

async function trendingScreen(query) {
  try {
    const { data } = await api.get('/tickers', { params: { quotes: 'USD', limit: 10 } });
    const list = Array.isArray(data) ? data.slice(0, 10) : [];
    const rows = list.map((c, i) => `${String(i + 1).padStart(2, '0')}  <b>${esc(c.symbol)}</b>  ${esc(c.name)}  <code>${fmtMoney(c.quotes?.USD?.price)}</code>  ${iconFor(c.quotes?.USD?.percent_change_24h)} ${pct(c.quotes?.USD?.percent_change_24h)}`).join('\n');
    const kb = { inline_keyboard: [...list.slice(0, 8).map(c => [{ text: `${c.symbol}  ${c.name}`.slice(0, 30), callback_data: `coin:open:${c.id}` }]), [{ text: '⬅️ Back to Menu', callback_data: 'ui:home' }]] };
    return editScreen(query, `🔥 <b>TRENDING COINS</b>\n\n<i>Top market assets right now.</i>\n\n${rows}\n\n<i>Updated ${nowLabel()} • WhalesCoin Live Data</i>`, kb);
  } catch { return editScreen(query, '⚠️ Trending data is temporarily unavailable.'); }
}

async function marketsScreen(query) {
  return editScreen(query, `📊 <b>MARKETS</b>\n\nSearch any coin to open its full market card.\n\nExample:\n<code>/price BTC</code>\n<code>/price ETH</code>\n<code>/price SOL</code>`, { inline_keyboard: [[{ text: '🔎 Search Coin', callback_data: 'ui:search' }], [{ text: '🔥 Trending', callback_data: 'ui:trending' }], [{ text: '⬅️ Back', callback_data: 'ui:home' }]] });
}

async function watchlistScreen(query) {
  const userId = query.from.id, chatId = query.message.chat.id;
  const items = [...watchMap.values()].filter(x => x.userId === userId && x.chatId === chatId);
  if (!items.length) return editScreen(query, `⭐ <b>MY WATCHLIST</b>\n\nYou are not tracking any coins yet.\n\nOpen a coin and tap <b>⭐ Add to Watchlist</b>.`);
  const rows = items.map(x => `• <b>${esc(x.symbol)}</b>  ${esc(x.name)}  <i>±${x.percent}%</i>`).join('\n');
  return editScreen(query, `⭐ <b>MY WATCHLIST</b>\n\nYou are tracking <b>${items.length}</b> coin${items.length > 1 ? 's' : ''}.\n\n${rows}\n\n<i>Alerts are memory-only in this version.</i>`);
}

async function rulesScreen(query) {
  return editScreen(query, `📜 <b>WHALESCOIN COMMUNITY RULES</b>\n\n<b>01</b> No scams or phishing.\n<b>02</b> No unauthorized promotions.\n<b>03</b> No spam or flooding.\n<b>04</b> No fake giveaways or guaranteed-profit claims.\n<b>05</b> No impersonation.\n<b>06</b> Respect members and admins.\n\n🛡️ Automated protection is active 24/7.\n\n<i>WhalesCoin • Safe Community</i>`);
}

async function searchPrompt(query) {
  pendingSearch.set(`${query.message.chat.id}:${query.from.id}`, Date.now());
  return editScreen(query, `🔎 <b>SEARCH COIN</b>\n\nSend me a coin name or symbol.\n\nExamples: <code>Bitcoin</code>, <code>BTC</code>, <code>Solana</code>, <code>SOL</code>\n\n<i>Type your search in the next message.</i>`, { inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'ui:home' }]] });
}

async function showCoinData(query, action, coinId) {
  const coin = await info(coinId);
  const m = await ticker(coinId);
  const usd = m?.quotes?.USD || {};
  let text = '';
  let kb = coinButtons(coinId);
  if (action === 'price' || action === 'refresh') {
    const ch = Number(usd.percent_change_24h || 0);
    text = `💰 <b>${coinTitle(coin)}</b>\n\n<b>${fmtMoney(usd.price)}</b>\n${iconFor(ch)} <b>${pct(ch)}</b> <i>24H</i>\n\n🏦 Market Cap  <b>${fmtMoney(usd.market_cap)}</b>\n📊 Volume      <b>${fmtMoney(usd.volume_24h)}</b>\n\n<i>Updated ${nowLabel()} • WhalesCoin Live Data</i>`;
  } else if (action === 'volume') {
    text = `📈 <b>${coinTitle(coin)} — VOLUME</b>\n\n💵 24H Volume  <b>${fmtMoney(usd.volume_24h)}</b>\n📊 Volume / Cap  <b>${usd.market_cap ? ((Number(usd.volume_24h || 0) / Number(usd.market_cap)) * 100).toFixed(2) + '%' : 'N/A'}</b>\n\n<i>WhalesCoin • Live Data</i>`;
  } else if (action === 'supply') {
    text = `💎 <b>${coinTitle(coin)} — SUPPLY</b>\n\n🪙 Circulating  <b>${fmtNum(m.circulating_supply)}</b>\n📦 Total       <b>${fmtNum(m.total_supply)}</b>\n♾️ Max         <b>${fmtNum(m.max_supply)}</b>\n\n<i>WhalesCoin • Live Data</i>`;
  } else if (action === 'about') {
    const desc = String(coin.description || 'No description available.').replace(/\s+/g, ' ').trim();
    text = `ℹ️ <b>ABOUT ${esc(coin.symbol || '')}</b>\n\n${esc(desc.slice(0, 1500))}\n\n<i>WhalesCoin • Coin Information</i>`;
  } else if (action === 'links') {
    const l = coin.links || {};
    const website = l.website?.[0], explorer = l.explorer?.[0], source = l.source_code?.[0];
    text = `🔗 <b>${coinTitle(coin)} — OFFICIAL LINKS</b>\n\n` +
      (website ? `🌐 <a href="${esc(website)}">Website</a>\n` : '') +
      (explorer ? `🔎 <a href="${esc(explorer)}">Explorer</a>\n` : '') +
      (source ? `💻 <a href="${esc(source)}">Source Code</a>\n` : '') +
      (!website && !explorer && !source ? 'No official links available.' : '');
  } else if (action === 'market') {
    const ms = await markets(coinId);
    const rows = ms.map((x, i) => `${i + 1}. <b>${esc(x.exchange_name || 'Exchange')}</b>\n   ${esc(x.base_symbol || coin.symbol)}/${esc(x.quote_symbol || 'USD')} • ${fmtMoney(x.adjusted_volume_24h || x.volume_24h)}`).join('\n');
    text = `📊 <b>${coinTitle(coin)} — MARKET</b>\n\n${rows || 'No exchange market data available.'}\n\n<i>WhalesCoin • Live Market Data</i>`;
  }
  if (action === 'watch') {
    const userId = query.from.id, chatId = query.message.chat.id;
    const watchKey = key(chatId, userId, coinId);
    if (!usd.price) return answer(query.id, 'Current price unavailable.', true);
    watchMap.set(watchKey, { chatId, userId, coinId, symbol: coin.symbol, name: coin.name, basePrice: Number(usd.price), percent: 5 });
    return answer(query.id, `${coin.symbol} added to your watchlist at ±5%.`, false);
  }
  return editScreen(query, text, kb);
}

async function adminScreen(query) {
  if (!isBotStaff(query.from)) return answer(query.id, 'Owner/Admin access only.', true);
  const groups = [...groupStats.values()].length;
  return editScreen(query, `👑 <b>WHALESCOIN CONTROL CENTER</b>\n\n🟢 Bot Online\n🟢 API Online\n🛡️ Moderation Active\n\n👑 Role: <b>${staffRole(query.from)}</b>\n👥 Known Groups: <b>${groups}</b>\n⭐ Watch Alerts: <b>${watchMap.size}</b>\n\n<i>No database • Memory-only operational state</i>`, { inline_keyboard: [
    [{ text: '📊 System', callback_data: 'admin:system' }, { text: '👥 Groups', callback_data: 'admin:groups' }],
    [{ text: '🛡 Moderation', callback_data: 'admin:moderation' }, { text: '👑 Staff', callback_data: 'admin:staff' }],
    [{ text: '⬅️ Back', callback_data: 'ui:home' }]
  ]});
}

const RESERVED = new Set(['start','help','rules','price','market','vol','supply','bio','link','trending','watch','watchlist','status','block','unblock','admin']);

bot.onText(/^\/start(?:@\w+)?$/i, async msg => send(msg.chat.id, homeText(), { reply_markup: homeKeyboard() }));
bot.onText(/^\/help(?:@\w+)?$/i, async msg => send(msg.chat.id, `🐋 <b>WHALESCOIN COMMANDS</b>\n\n📊 <code>/price BTC</code>\n📊 <code>/market BTC</code>\n📈 <code>/vol BTC</code>\n💎 <code>/supply BTC</code>\nℹ️ <code>/bio BTC</code>\n🔗 <code>/link BTC</code>\n🔥 <code>/trending</code>\n⭐ <code>/watch BTC 5</code>\n⭐ <code>/watchlist</code>\n📜 <code>/rules</code>\n👑 <code>/admin</code> (staff only)\n\n<i>You can also use /BTC, /ETH, /SOL etc.</i>`, { reply_markup: backMenu() }));
bot.onText(/^\/rules(?:@\w+)?$/i, async msg => send(msg.chat.id, `📜 <b>WHALESCOIN COMMUNITY RULES</b>\n\n01 • No scams or phishing.\n02 • No unauthorized promotions.\n03 • No spam or flooding.\n04 • No fake giveaways.\n05 • No impersonation.\n06 • Respect members and admins.\n\n🛡️ Automated protection is active.`, { reply_markup: backMenu() }));

async function commandCoin(msg, match, action) {
  const q = String(match?.[1] || '').trim();
  if (!q) return send(msg.chat.id, `ℹ️ Use <code>/${action} BTC</code>.`);
  const c = await searchCoin(q);
  if (!c) return send(msg.chat.id, `❌ Coin <b>${esc(q)}</b> was not found.`);
  if (action === 'price') return sendCoinCard(msg.chat.id, c);
  const fakeQuery = { message: { chat: { id: msg.chat.id }, message_id: 0 }, from: msg.from, id: `cmd-${Date.now()}` };
  const textMsg = await send(msg.chat.id, '⏳ Loading…');
  if (textMsg) fakeQuery.message.message_id = textMsg.message_id;
  await showCoinData(fakeQuery, action === 'vol' ? 'volume' : action, c.id);
}

for (const action of ['price','market','vol','supply','bio','link']) {
  bot.onText(new RegExp(`^\\/${action}(?:@\\w+)?(?:\\s+(.+))?$`, 'i'), (msg, match) => commandCoin(msg, match, action));
}
bot.onText(/^\/trending(?:@\w+)?$/i, async msg => {
  const q = { message: { chat: { id: msg.chat.id }, message_id: (await send(msg.chat.id, '⏳ Loading market…'))?.message_id }, from: msg.from };
  await trendingScreen(q);
});
bot.onText(/^\/watch(?:@\w+)?(?:\s+([A-Za-z0-9$._-]+)\s+([0-9]+(?:\.[0-9]+)?))?$/i, async (msg, match) => {
  const q = String(match?.[1] || ''), p = Number(match?.[2] || 0);
  if (!q || !p || p <= 0 || p > 1000) return send(msg.chat.id, '⭐ Use <code>/watch BTC 5</code> to create a ±5% alert.');
  const c = await searchCoin(q); if (!c) return send(msg.chat.id, '❌ Coin not found.');
  const m = await ticker(c.id); const price = Number(m?.quotes?.USD?.price || 0); if (!price) return send(msg.chat.id, '⚠️ Current price unavailable.');
  watchMap.set(key(msg.chat.id, msg.from.id, c.id), { chatId: msg.chat.id, userId: msg.from.id, coinId: c.id, symbol: c.symbol, name: c.name, basePrice: price, percent: p });
  return send(msg.chat.id, `⭐ <b>${esc(c.symbol)} added to Watchlist</b>\n\nBase: <b>${fmtMoney(price)}</b>\nTrigger: <b>±${p}%</b>\n\n<i>Memory-only in this version.</i>`);
});
bot.onText(/^\/watchlist(?:@\w+)?$/i, async msg => {
  const items = [...watchMap.values()].filter(x => x.chatId === msg.chat.id && x.userId === msg.from.id);
  return send(msg.chat.id, items.length ? `⭐ <b>MY WATCHLIST</b>\n\n${items.map(x => `• <b>${esc(x.symbol)}</b> ${esc(x.name)} — ±${x.percent}%`).join('\n')}` : '⭐ <b>MY WATCHLIST</b>\n\nNo active alerts.', { reply_markup: backMenu() });
});
bot.onText(/^\/admin(?:@\w+)?$/i, async msg => {
  if (!isBotStaff(msg.from)) return send(msg.chat.id, '⛔ Owner/Admin access only.');
  return send(msg.chat.id, `👑 <b>WHALESCOIN CONTROL CENTER</b>\n\n🟢 Bot Online\n🟢 API Online\n🛡️ Moderation Active\n\nRole: <b>${staffRole(msg.from)}</b>`, { reply_markup: { inline_keyboard: [[{ text: '📊 Open Control Center', callback_data: 'admin:open' }]] } });
});
bot.onText(/^\/status(?:@\w+)?$/i, async msg => {
  if (!(await isGroupAdmin(msg.chat.id, msg.from.id))) return;
  send(msg.chat.id, `🛡️ <b>MODERATION STATUS</b>\n\n🟢 Link protection: <b>Active</b>\n🟢 Anti-spam: <b>Active</b>\n🟢 Scam phrase filter: <b>Active</b>\n🟢 Admin protection: <b>Enabled</b>\n💾 Database: <b>Not Used</b>`);
});
bot.onText(/^\/block(?:@\w+)?$/i, async msg => {
  if (!(await isGroupAdmin(msg.chat.id, msg.from.id))) return;
  const target = msg.reply_to_message?.from;
  if (!target) return send(msg.chat.id, 'ℹ️ Reply to a user message with <code>/block</code>.');
  if (await isGroupAdmin(msg.chat.id, target.id)) return send(msg.chat.id, '⚠️ Administrators cannot be blocked with this command.');
  if (await ban(msg.chat.id, target.id)) { await del(msg.chat.id, msg.message_id); return send(msg.chat.id, `🚫 <b>User Banned</b>\n\n${userLabel(target)} was removed by an administrator.`); }
});
bot.onText(/^\/unblock(?:@\w+)?\s+(\d+)$/i, async (msg, match) => {
  if (!(await isGroupAdmin(msg.chat.id, msg.from.id))) return;
  try { await bot.unbanChatMember(msg.chat.id, Number(match[1]), { only_if_banned: true }); await send(msg.chat.id, `✅ User <code>${match[1]}</code> unblocked.`); } catch { await send(msg.chat.id, '⚠️ Unable to unblock this user.'); }
});

bot.onText(/^\/([a-z0-9]{2,15})(?:@\w+)?$/i, async (msg, match) => {
  const t = String(match?.[1] || '').toLowerCase(); if (RESERVED.has(t)) return;
  const c = await searchCoin(t); if (!c) return send(msg.chat.id, `❌ Coin <b>${esc(t)}</b> was not found.`);
  await sendCoinCard(msg.chat.id, c);
});

bot.on('callback_query', async q => {
  const data = q.data || '';
  try {
    if (data === 'ui:home') { await answer(q.id); return editScreen(q, homeText(), homeKeyboard()); }
    if (data === 'ui:markets') { await answer(q.id); return marketsScreen(q); }
    if (data === 'ui:trending') { await answer(q.id); return trendingScreen(q); }
    if (data === 'ui:search') { await answer(q.id); return searchPrompt(q); }
    if (data === 'ui:watchlist') { await answer(q.id); return watchlistScreen(q); }
    if (data === 'ui:rules') { await answer(q.id); return rulesScreen(q); }
    if (data === 'admin:open') { return adminScreen(q); }
    if (data.startsWith('admin:')) {
      if (!isBotStaff(q.from)) return answer(q.id, 'Owner/Admin access only.', true);
      const action = data.split(':')[1];
      const text = action === 'system' ? '📊 <b>SYSTEM</b>\n\n🟢 Bot: Online\n🟢 API: Online\n🟢 Webhook: Active\n🛡️ Moderation: Active' :
        action === 'groups' ? `👥 <b>GROUPS</b>\n\nKnown groups: <b>${groupStats.size}</b>\n\nGroup state is memory-only.` :
        action === 'moderation' ? '🛡️ <b>MODERATION</b>\n\n🔗 Unauthorized links → Delete + Ban\n🚨 Flood → Delete + Restrict\n⚠️ Scam phrases → Delete + Escalate\n👑 Telegram admins → Exempt' :
        '👑 <b>STAFF</b>\n\nOwner: <code>' + esc(OWNER_ID || OWNER_USERNAME || 'Not configured') + '</code>\nSuper Admins: <b>' + STAFF_USERNAMES.size + '</b>';
      return editScreen(q, text, { inline_keyboard: [[{ text: '⬅️ Control Center', callback_data: 'admin:open' }], [{ text: '🏠 Home', callback_data: 'ui:home' }]] });
    }
    if (data.startsWith('coin:')) {
      const [, action, id] = data.split(':');
      await answer(q.id);
      if (action === 'open') return sendCoinCard(q.message.chat.id, { id, name: 'Loading…', symbol: 'COIN' });
      return showCoinData(q, action, id);
    }
  } catch (e) { console.log('callback:', e.message); await answer(q.id, 'Something went wrong. Try again.', true); }
});

bot.on('message', async msg => {
  if (!msg.chat) return;
  const gk = String(msg.chat.id);
  if (['group', 'supergroup'].includes(msg.chat.type)) groupStats.set(gk, { title: msg.chat.title || 'Group', lastSeen: Date.now() });

  if (msg.from && !msg.from.is_bot && pendingSearch.has(`${msg.chat.id}:${msg.from.id}`) && !String(msg.text || '').startsWith('/')) {
    pendingSearch.delete(`${msg.chat.id}:${msg.from.id}`);
    const c = await searchCoin(msg.text);
    if (!c) return send(msg.chat.id, `❌ No coin found for <b>${esc(msg.text)}</b>.`);
    return sendCoinCard(msg.chat.id, c);
  }

  if (!['group','supergroup'].includes(msg.chat.type)) return;
  if (!msg.from || msg.from.is_bot) return;
  const text = normalizeText(msg);
  if (text.startsWith('/')) return;
  if (await isGroupAdmin(msg.chat.id, msg.from.id)) return;

  if (URL_REGEX.test(text) && !allowedUrl(text)) {
    await del(msg.chat.id, msg.message_id);
    const ok = await ban(msg.chat.id, msg.from.id);
    if (ok) await send(msg.chat.id, `🚨 <b>SECURITY ACTION</b>\n\n👤 ${userLabel(msg.from)}\n🔗 Reason: <b>Unauthorized external link</b>\n🛡️ Action: <b>BANNED</b>`);
    return;
  }
  if (containsBlocked(text)) {
    await del(msg.chat.id, msg.message_id);
    const n = violation(msg.chat.id, msg.from.id);
    if (n >= 2) {
      if (await ban(msg.chat.id, msg.from.id)) await send(msg.chat.id, `🚫 <b>MODERATION ACTION</b>\n\n👤 ${userLabel(msg.from)}\n⚠️ Repeated prohibited content\n🛡️ <b>User banned</b>`);
    } else {
      await restrict(msg.chat.id, msg.from.id, 600);
      await send(msg.chat.id, `⚠️ <b>COMMUNITY GUIDELINES</b>\n\n${userLabel(msg.from)}, your message was removed.\n🔇 Temporary restriction applied.`);
    }
    return;
  }
  if (flood(msg.chat.id, msg.from.id)) {
    await del(msg.chat.id, msg.message_id);
    await restrict(msg.chat.id, msg.from.id, 600);
    await send(msg.chat.id, `🚨 <b>ANTI-SPAM PROTECTION</b>\n\n${userLabel(msg.from)} was temporarily restricted for message flooding.`);
  }
});

bot.on('new_chat_members', async msg => {
  const users = (msg.new_chat_members || []).filter(u => !u.is_bot); if (!users.length) return;
  await send(msg.chat.id, `🐋 <b>WELCOME TO WHALESCOIN</b>\n\nWelcome ${users.map(userLabel).join(', ')} 👋\n\n📊 Live crypto data\n🔥 Trending coins\n⭐ Personal watchlists\n🛡️ Automated community protection\n\n<i>Please read /rules before posting.</i>`, { reply_markup: { inline_keyboard: [[{ text: '📊 Markets', callback_data: 'ui:markets' }, { text: '📜 Rules', callback_data: 'ui:rules' }]] } });
});

setInterval(async () => {
  for (const [k, a] of watchMap.entries()) {
    try {
      const m = await ticker(a.coinId), price = Number(m?.quotes?.USD?.price || 0); if (!price) continue;
      const move = ((price - a.basePrice) / a.basePrice) * 100;
      if (Math.abs(move) >= a.percent) {
        await send(a.chatId, `🔔 <b>PRICE ALERT</b>\n\n🪙 <b>${esc(a.name)} (${esc(a.symbol)})</b>\n💰 Current: <b>${fmtMoney(price)}</b>\n📊 Move: <b>${pct(move)}</b>\n🎯 Trigger: ±${a.percent}%`, { reply_markup: { inline_keyboard: [[{ text: '📊 Open Coin', callback_data: `coin:open:${a.coinId}` }]] } });
        watchMap.delete(k);
      }
    } catch {}
  }
}, 5 * 60 * 1000);

app.get('/', (_req, res) => res.status(200).send(`${BRAND_NAME} Bot is online.`));
app.get('/health', (_req, res) => res.json({ ok: true, service: BRAND_NAME, mode: 'webhook', database: false }));
app.post(`/telegram/${WEBHOOK_SECRET}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });

const COMMANDS = [
  { command: 'start', description: 'Open WhalesCoin' },
  { command: 'price', description: 'Live coin price: /price BTC' },
  { command: 'trending', description: 'Trending market' },
  { command: 'watch', description: 'Create alert: /watch BTC 5' },
  { command: 'watchlist', description: 'Your watchlist' },
  { command: 'help', description: 'Command guide' },
  { command: 'rules', description: 'Community rules' }
];

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`${BRAND_NAME} running on ${PORT}`);
  try { await bot.setMyCommands(COMMANDS); } catch (e) { console.log('commands:', e.message); }
  if (process.env.RENDER_EXTERNAL_URL) {
    try { await bot.setWebHook(`${process.env.RENDER_EXTERNAL_URL}/telegram/${WEBHOOK_SECRET}`); console.log('Webhook configured.'); }
    catch (e) { console.log('webhook:', e.message); }
  }
});
