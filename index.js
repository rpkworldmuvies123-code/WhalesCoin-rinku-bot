require("dotenv").config();

const express = require("express");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET || "whalescoin-secure-webhook";
const BRAND_NAME = process.env.BRAND_NAME || "WhalesCoin.Ai";
const PORT = process.env.PORT || 10000;

const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "")
  .split(",")
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);

const EXTRA_BLOCKED_WORDS = (process.env.BLOCKED_WORDS || "")
  .split(",")
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN environment variable.");
  process.exit(1);
}

const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const paprika = axios.create({
  baseURL: "https://api.coinpaprika.com/v1",
  timeout: 15000
});

// No database. These reset if Render restarts.
const floodMap = new Map();
const violationMap = new Map();
const watchMap = new Map();

const URL_REGEX =
  /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|[a-z0-9-]+\.(?:com|net|org|io|co|in|xyz|me|app|site|online|shop|info|biz|link|live|pro|ai)(?:\/|\b))/i;

const DEFAULT_BLOCKED_WORDS = [
  "scam link",
  "free usdt",
  "guaranteed profit",
  "double your money",
  "dm for investment"
];

const blockedWords = [...DEFAULT_BLOCKED_WORDS, ...EXTRA_BLOCKED_WORDS];

const COMMANDS = [
  { command: "btc", description: "Bitcoin data + options" },
  { command: "eth", description: "Ethereum data + options" },
  { command: "bnb", description: "BNB data + options" },
  { command: "sol", description: "Solana data + options" },
  { command: "doge", description: "Dogecoin data + options" },
  { command: "shib", description: "Shiba Inu data + options" },
  { command: "price", description: "Live price data: /price BTC" },
  { command: "market", description: "Exchange markets: /market BTC" },
  { command: "vol", description: "Coin volume: /vol BTC" },
  { command: "supply", description: "Coin supply: /supply BTC" },
  { command: "bio", description: "Coin description: /bio BTC" },
  { command: "link", description: "Official links: /link BTC" },
  { command: "watch", description: "Create price alert: /watch BTC 5" },
  { command: "watchlist", description: "List your price alerts" },
  { command: "trending", description: "Top market cryptocurrencies" },
  { command: "rules", description: "Community rules" },
  { command: "help", description: "Command list" },
  { command: "status", description: "Admin moderation status" },
  { command: "block", description: "Reply to a user to ban" },
  { command: "unblock", description: "Unban by Telegram user ID" }
];

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function displayUser(user) {
  if (!user) return "Unknown";
  if (user.username) return `@${escapeHtml(user.username)}`;
  return `<a href="tg://user?id=${user.id}">${escapeHtml(
    user.first_name || "Member"
  )}</a>`;
}

function normalizeText(msg) {
  return `${msg.text || ""} ${msg.caption || ""}`.trim();
}

function containsUrl(text) {
  return URL_REGEX.test(text || "");
}

function extractDomains(text) {
  const matches =
    (text || "").match(
      /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi
    ) || [];

  return matches.map(raw => {
    try {
      const clean = raw.startsWith("http") ? raw : `https://${raw}`;
      return new URL(clean).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return raw
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .split("/")[0]
        .toLowerCase();
    }
  });
}

function urlIsAllowed(text) {
  if (!containsUrl(text)) return true;
  if (ALLOWED_DOMAINS.length === 0) return false;

  const domains = extractDomains(text);
  if (!domains.length) return false;

  return domains.every(domain =>
    ALLOWED_DOMAINS.some(
      allowed => domain === allowed || domain.endsWith(`.${allowed}`)
    )
  );
}

function containsBlockedLanguage(text) {
  const lower = (text || "").toLowerCase();
  return blockedWords.some(word => word && lower.includes(word));
}

async function isAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ["creator", "administrator"].includes(member.status);
  } catch {
    return false;
  }
}

async function safeDelete(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (err) {
    console.log("Delete failed:", err.message);
  }
}

async function sendNotice(chatId, html, replyToMessageId = null, extra = {}) {
  try {
    const options = {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    };

    if (replyToMessageId) {
      options.reply_to_message_id = replyToMessageId;
    }

    return await bot.sendMessage(chatId, html, options);
  } catch (err) {
    console.log("Notice failed:", err.message);
  }
}

async function banUser(chatId, userId) {
  try {
    await bot.banChatMember(chatId, userId);
    return true;
  } catch (err) {
    console.log("Ban failed:", err.message);
    return false;
  }
}

async function restrictUser(chatId, userId, seconds = 600) {
  try {
    const untilDate = Math.floor(Date.now() / 1000) + seconds;

    await bot.restrictChatMember(chatId, userId, {
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
        can_manage_topics: false
      },
      until_date: untilDate
    });

    return true;
  } catch (err) {
    console.log("Restrict failed:", err.message);
    return false;
  }
}

function addViolation(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const count = (violationMap.get(key) || 0) + 1;
  violationMap.set(key, count);
  return count;
}

function isFlooding(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const windowMs = 10_000;
  const maxMessages = 7;

  const old = floodMap.get(key) || [];
  const recent = old.filter(ts => now - ts <= windowMs);

  recent.push(now);
  floodMap.set(key, recent);

  return recent.length > maxMessages;
}

function fmtMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "N/A";
  }

  const num = Number(value);

  if (Math.abs(num) >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
  if (Math.abs(num) >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (Math.abs(num) >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;

  if (Math.abs(num) >= 1) {
    return `$${num.toLocaleString("en-US", {
      maximumFractionDigits: 6
    })}`;
  }

  return `$${num.toLocaleString("en-US", {
    maximumFractionDigits: 12
  })}`;
}

function fmtNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "N/A";
  }

  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: 2
  });
}

function changeIcon(value) {
  const n = Number(value || 0);
  return n >= 0 ? "🟢" : "🔴";
}

function formatPercent(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function normalizeTicker(query) {
  return String(query || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase();
}

async function findCoin(query) {
  const q = String(query || "").trim();
  if (!q) return null;

  const ticker = normalizeTicker(q);

  try {
    const { data } = await paprika.get("/search", {
      params: { q, c: "currencies" }
    });

    const currencies = data?.currencies || [];

    return (
      currencies.find(c => c.symbol?.toUpperCase() === ticker) ||
      currencies.find(c => c.id?.toLowerCase() === q.toLowerCase()) ||
      currencies[0] ||
      null
    );
  } catch (err) {
    console.log("Coin search error:", err.response?.data || err.message);
    return null;
  }
}

async function getTicker(coinId) {
  const { data } = await paprika.get(`/tickers/${coinId}`);
  return data;
}

async function getCoinInfo(coinId) {
  const { data } = await paprika.get(`/coins/${coinId}`);
  return data;
}

async function getCoinMarkets(coinId) {
  const { data } = await paprika.get(`/coins/${coinId}/markets`, {
    params: {
      quotes: "USD",
      limit: 10
    }
  });
  return Array.isArray(data) ? data : [];
}

async function getTodayOhlcv(coinId) {
  try {
    const { data } = await paprika.get(`/coins/${coinId}/ohlcv/today`);
    return Array.isArray(data) && data[0] ? data[0] : null;
  } catch {
    return null;
  }
}

function marketMood(change24h) {
  const n = Number(change24h || 0);
  if (n >= 5) return "🚀 Strong bullish momentum";
  if (n >= 1) return "🟢 Buyers are in control";
  if (n > -1) return "⚪ Market is moving sideways";
  if (n > -5) return "🔴 Sellers are in control";
  return "⚠️ Strong bearish pressure";
}

function updatedLabel() {
  return "🕐 Updated just now";
}

function coinKeyboard(coinId) {
  return {
    inline_keyboard: [
      [
        { text: "💰 Price", callback_data: `coin:price:${coinId}` },
        { text: "🏦 Markets", callback_data: `coin:market:${coinId}` }
      ],
      [
        { text: "📈 Volume", callback_data: `coin:vol:${coinId}` },
        { text: "💎 Supply", callback_data: `coin:supply:${coinId}` }
      ],
      [
        { text: "ℹ️ About", callback_data: `coin:bio:${coinId}` },
        { text: "🔗 Links", callback_data: `coin:link:${coinId}` }
      ],
      [
        { text: "🔄 Refresh", callback_data: `coin:refresh:${coinId}` },
        { text: "🔥 Trending", callback_data: "global:trending" }
      ]
    ]
  };
}

async function buildCoinView(coin, action = "refresh") {
  const market = await getTicker(coin.id);
  const usd = market?.quotes?.USD || {};
  const change = Number(usd.percent_change_24h || 0);
  const title = coinTitle(market);

  if (action === "price" || action === "refresh") {
    const ohlcv = await getTodayOhlcv(coin.id);
    const high = ohlcv?.high;
    const low = ohlcv?.low;
    return `🐋 <b>${title}</b>

` +
      `💰 <b>${fmtMoney(usd.price)}</b>
` +
      `${changeIcon(change)} <b>24H:</b> ${formatPercent(change)}   •   <b>7D:</b> ${formatPercent(usd.percent_change_7d)}

` +
      `🏦 <b>Market Cap:</b> ${fmtMoney(usd.market_cap)}
` +
      `📊 <b>24H Volume:</b> ${fmtMoney(usd.volume_24h)}
` +
      `🔼 <b>Today High:</b> ${fmtMoney(high)}
` +
      `🔽 <b>Today Low:</b> ${fmtMoney(low)}
` +
      `🏅 <b>Rank:</b> #${market.rank || "N/A"}

` +
      `${marketMood(change)}
` +
      `${updatedLabel()}

` +
      `<i>🐋 WhalesCoin • Live Market Data</i>`;
  }

  if (action === "vol") {
    const ratio = usd.market_cap
      ? ((Number(usd.volume_24h || 0) / Number(usd.market_cap)) * 100).toFixed(2) + "%"
      : "N/A";
    return `📈 <b>${title} — Volume</b>

` +
      `💵 <b>24H Volume:</b> ${fmtMoney(usd.volume_24h)}
` +
      `📊 <b>Volume / Market Cap:</b> ${ratio}
` +
      `🔁 <b>24H Change:</b> ${formatPercent(change)}

` +
      `${updatedLabel()}

<i>🐋 WhalesCoin • Live Market Data</i>`;
  }

  if (action === "supply") {
    const circ = Number(market.circulating_supply || 0);
    const max = Number(market.max_supply || 0);
    const mined = max > 0 ? ((circ / max) * 100).toFixed(2) + "%" : "N/A";
    return `💎 <b>${title} — Supply</b>

` +
      `🪙 <b>Circulating:</b> ${fmtNumber(market.circulating_supply)}
` +
      `📦 <b>Total:</b> ${fmtNumber(market.total_supply)}
` +
      `♾️ <b>Max:</b> ${fmtNumber(market.max_supply)}
` +
      `⛏️ <b>Circulating / Max:</b> ${mined}

` +
      `${updatedLabel()}

<i>🐋 WhalesCoin • Live Market Data</i>`;
  }

  if (action === "market") {
    const markets = await getCoinMarkets(coin.id);
    const rows = markets.slice(0, 5).map((m, i) => {
      const pair = `${m.base_symbol || market.symbol}/${m.quote_symbol || "USD"}`;
      const volume = m.adjusted_volume_24h || m.volume_24h || 0;
      return `${i + 1}. <b>${escapeHtml(m.exchange_name || "Exchange")}</b> • ${escapeHtml(pair)}
   Vol ${fmtMoney(volume)}`;
    });
    return `🏦 <b>${title} — Top Markets</b>

${rows.join("\n")}

${updatedLabel()}

<i>🐋 WhalesCoin • Live Market Data</i>`;
  }

  if (action === "bio") {
    const info = await getCoinInfo(coin.id);
    const description = String(info.description || "No description available.").replace(/\s+/g, " ").trim();
    const shortDescription = description.length > 650 ? `${description.slice(0, 647)}...` : description;
    return `ℹ️ <b>${coinTitle(info)}</b>

${escapeHtml(shortDescription)}

<i>🐋 WhalesCoin • Coin Overview</i>`;
  }

  if (action === "link") {
    const info = await getCoinInfo(coin.id);
    const links = info.links || {};
    const website = Array.isArray(links.website) ? links.website[0] : null;
    const explorer = Array.isArray(links.explorer) ? links.explorer[0] : null;
    const source = Array.isArray(links.source_code) ? links.source_code[0] : null;
    let out = `🔗 <b>${coinTitle(info)} — Official Links</b>

`;
    if (website) out += `🌐 <a href="${escapeHtml(website)}">Official Website</a>
`;
    if (explorer) out += `🔎 <a href="${escapeHtml(explorer)}">Blockchain Explorer</a>
`;
    if (source) out += `💻 <a href="${escapeHtml(source)}">Source Code</a>
`;
    if (!website && !explorer && !source) out += "No official links available.";
    return out + `

<i>🐋 WhalesCoin • Verified Project Links</i>`;
  }

  return buildCoinView(coin, "refresh");
}

async function updateCoinCard(query, coin, action) {
  const text = await buildCoinView(coin, action);
  const options = {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: "HTML",
    reply_markup: coinKeyboard(coin.id)
  };

  if (query.message.photo) {
    return bot.editMessageCaption(text, options);
  }
  return bot.editMessageText(text, { ...options, disable_web_page_preview: true });
}

function coinTitle(coin) {
  return `${escapeHtml(coin.name || "Unknown")} (${escapeHtml(
    coin.symbol || ""
  )})`;
}

async function resolveTicker(chatId, query) {
  const coin = await findCoin(query);

  if (!coin) {
    await sendNotice(
      chatId,
      `❌ Coin not found: <b>${escapeHtml(query)}</b>\n\nTry a ticker like <code>BTC</code>, <code>ETH</code> or <code>SOL</code>.`
    );
    return null;
  }

  return coin;
}

async function sendPrice(chatId, coin) {
  try {
    const market = await getTicker(coin.id);
    const usd = market?.quotes?.USD;

    if (!usd) {
      return sendNotice(chatId, "⚠️ Market data is temporarily unavailable.");
    }

    const change = Number(usd.percent_change_24h || 0);

    const text = `📊 <b>${coinTitle(market)}</b>

💰 <b>Price:</b> ${fmtMoney(usd.price)}
${changeIcon(change)} <b>24h:</b> ${formatPercent(change)}
🏦 <b>Market Cap:</b> ${fmtMoney(usd.market_cap)}
📈 <b>24h Volume:</b> ${fmtMoney(usd.volume_24h)}
🔼 <b>24h High:</b> ${fmtMoney(usd.ath_price || usd.price)}
🔽 <b>24h Low:</b> N/A

<i>🐋 Powered by WhalesCoin.</i>`;

    await sendNotice(chatId, text);
  } catch (err) {
    console.log("Price error:", err.response?.data || err.message);
    await sendNotice(chatId, "⚠️ Market data could not be loaded right now.");
  }
}

async function sendMarket(chatId, coin) {
  try {
    const markets = await getCoinMarkets(coin.id);

    if (!markets.length) {
      return sendNotice(chatId, "⚠️ Exchange market data is unavailable.");
    }

    const rows = markets.slice(0, 8).map((m, i) => {
      const pair = `${m.base_symbol || coin.symbol}/${m.quote_symbol || "USD"}`;
      const volume = m.adjusted_volume_24h || m.volume_24h || 0;

      return `${i + 1}. <b>${escapeHtml(
        m.exchange_name || "Exchange"
      )}</b>\n   ${escapeHtml(pair)} • Vol ${fmtMoney(volume)}`;
    });

    await sendNotice(
      chatId,
      `🏦 <b>${coinTitle(coin)} — Markets</b>\n\n${rows.join(
        "\n"
      )}\n\n<i>🐋 Powered by WhalesCoin.</i>`
    );
  } catch (err) {
    console.log("Market error:", err.response?.data || err.message);
    await sendNotice(chatId, "⚠️ Exchange market data could not be loaded.");
  }
}

async function sendVolume(chatId, coin) {
  try {
    const market = await getTicker(coin.id);
    const usd = market?.quotes?.USD;

    if (!usd) {
      return sendNotice(chatId, "⚠️ Volume data is unavailable.");
    }

    await sendNotice(
      chatId,
      `📈 <b>${coinTitle(market)} — Volume</b>

💵 <b>24h Volume:</b> ${fmtMoney(usd.volume_24h)}
📊 <b>Volume / Market Cap:</b> ${
        usd.market_cap
          ? ((Number(usd.volume_24h || 0) / Number(usd.market_cap)) * 100).toFixed(
              2
            ) + "%"
          : "N/A"
      }

<i>🐋 Powered by WhalesCoin.</i>`
    );
  } catch (err) {
    console.log("Volume error:", err.response?.data || err.message);
    await sendNotice(chatId, "⚠️ Volume data could not be loaded.");
  }
}

async function sendSupply(chatId, coin) {
  try {
    const market = await getTicker(coin.id);

    await sendNotice(
      chatId,
      `💎 <b>${coinTitle(market)} — Supply</b>

🪙 <b>Circulating:</b> ${fmtNumber(market.circulating_supply)}
📦 <b>Total:</b> ${fmtNumber(market.total_supply)}
♾️ <b>Max:</b> ${fmtNumber(market.max_supply)}

<i>🐋 Powered by WhalesCoin.</i>`
    );
  } catch (err) {
    console.log("Supply error:", err.response?.data || err.message);
    await sendNotice(chatId, "⚠️ Supply data could not be loaded.");
  }
}

async function sendBio(chatId, coin) {
  try {
    const info = await getCoinInfo(coin.id);
    const description = String(info.description || "No description available.")
      .replace(/\s+/g, " ")
      .trim();

    const shortDescription =
      description.length > 900
        ? `${description.slice(0, 897)}...`
        : description;

    await sendNotice(
      chatId,
      `ℹ️ <b>${coinTitle(info)}</b>

${escapeHtml(shortDescription)}

<i>🐋 Powered by WhalesCoin.</i>`
    );
  } catch (err) {
    console.log("Bio error:", err.response?.data || err.message);
    await sendNotice(chatId, "⚠️ Coin description could not be loaded.");
  }
}

async function sendLinks(chatId, coin) {
  try {
    const info = await getCoinInfo(coin.id);
    const links = info.links || {};

    const website =
      Array.isArray(links.website) && links.website[0]
        ? links.website[0]
        : null;

    const explorer =
      Array.isArray(links.explorer) && links.explorer[0]
        ? links.explorer[0]
        : null;

    const sourceCode =
      Array.isArray(links.source_code) && links.source_code[0]
        ? links.source_code[0]
        : null;

    let text = `🔗 <b>${coinTitle(info)} — Official Links</b>\n\n`;

    if (website) text += `🌐 <a href="${escapeHtml(website)}">Website</a>\n`;
    if (explorer) text += `🔎 <a href="${escapeHtml(explorer)}">Explorer</a>\n`;
    if (sourceCode)
      text += `💻 <a href="${escapeHtml(sourceCode)}">Source Code</a>\n`;

    if (!website && !explorer && !sourceCode) {
      text += "No official links available.";
    }

    await sendNotice(chatId, text);
  } catch (err) {
    console.log("Links error:", err.response?.data || err.message);
    await sendNotice(chatId, "⚠️ Official links could not be loaded.");
  }
}

async function sendCoinMenu(chatId, coin, messageId = null) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "💰 Price", callback_data: `coin:price:${coin.id}` },
        { text: "🏦 Market", callback_data: `coin:market:${coin.id}` }
      ],
      [
        { text: "📈 Volume", callback_data: `coin:vol:${coin.id}` },
        { text: "💎 Supply", callback_data: `coin:supply:${coin.id}` }
      ],
      [
        { text: "ℹ️ Bio", callback_data: `coin:bio:${coin.id}` },
        { text: "🔗 Links", callback_data: `coin:link:${coin.id}` }
      ]
    ]
  };

  const text = `🐋 <b>${coinTitle(coin)}</b>

Select the crypto data you want:

💰 Price
🏦 Exchange markets
📈 Volume
💎 Supply
ℹ️ Description
🔗 Official links`;

  if (messageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: keyboard
      });
      return;
    } catch {}
  }

  await sendNotice(chatId, text, null, {
    reply_markup: keyboard
  });
}



function coinLogoUrl(coinId) {
  return `https://static.coinpaprika.com/coin/${coinId}/logo.png`;
}

async function sendCoinCard(chatId, coin) {
  try {
    const caption = await buildCoinView(coin, "refresh");
    const keyboard = coinKeyboard(coin.id);

    try {
      return await bot.sendPhoto(chatId, coinLogoUrl(coin.id), {
        caption,
        parse_mode: "HTML",
        reply_markup: keyboard
      });
    } catch (imageErr) {
      console.log("Coin logo send failed:", imageErr.message);
      return await sendNotice(chatId, caption, null, { reply_markup: keyboard });
    }
  } catch (err) {
    console.log("Coin card error:", err.response?.data || err.message);
    return sendNotice(chatId, "⚠️ Coin data could not be loaded right now.");
  }
}

// -------------------------
// Commands
// -------------------------

bot.onText(/^\/start(?:@\w+)?$/i, async msg => {
  await sendNotice(
    msg.chat.id,
    `🐋 <b>${escapeHtml(BRAND_NAME)}</b>

Your fast, interactive crypto market assistant. 🚀

🪙 Type <code>/btc</code>, <code>/eth</code>, <code>/sol</code> or almost any ticker
📊 Get live price, volume, markets and supply
🔄 Refresh data without filling the chat with messages
🔥 Explore trending coins
🔔 Create simple percentage alerts
🛡️ Built-in community moderation

<b>Quick start:</b> <code>/btc</code>

<i>🐋 WhalesCoin • Crypto made simple</i>`
  );
});

bot.onText(/^\/help(?:@\w+)?$/i, async msg => {
  await sendNotice(
    msg.chat.id,
    `📋 <b>${escapeHtml(BRAND_NAME)} — Commands</b>

<b>Market Data</b>
<code>/price BTC</code> — Live price
<code>/market BTC</code> — Exchange markets
<code>/vol BTC</code> — Volume data
<code>/supply BTC</code> — Supply data
<code>/bio BTC</code> — Coin description
<code>/link BTC</code> — Official links
<code>/trending</code> — Top market coins

<b>Alerts</b>
<code>/watch BTC 5</code> — Alert at ±5%
<code>/watchlist</code> — Your active alerts

<b>Community</b>
<code>/rules</code> — Community rules

<b>Admin</b>
<code>/status</code>
<code>/block</code> — Reply to a user
<code>/unblock USER_ID</code>

<i>Admins are exempt from automatic moderation.</i>`
  );
});

bot.onText(/^\/rules(?:@\w+)?$/i, async msg => {
  await sendNotice(
    msg.chat.id,
    `🛡️ <b>Community Rules</b>

1. No unauthorized links, promotions or referrals.
2. No spam, flooding or repetitive messages.
3. No abusive, threatening or inappropriate content.
4. No fake giveaways or guaranteed-profit claims.
5. Respect members and administrators.

⚠️ Violations may result in message removal, restriction or ban.`
  );
});

async function commandWithCoin(msg, match, action) {
  const query = (match?.[1] || "").trim();

  if (!query) {
    return sendNotice(
      msg.chat.id,
      `ℹ️ Use: <code>/${action} BTC</code>`
    );
  }

  const coin = await resolveTicker(msg.chat.id, query);
  if (!coin) return;

  if (action === "price") return sendPrice(msg.chat.id, coin);
  if (action === "market") return sendMarket(msg.chat.id, coin);
  if (action === "vol") return sendVolume(msg.chat.id, coin);
  if (action === "supply") return sendSupply(msg.chat.id, coin);
  if (action === "bio") return sendBio(msg.chat.id, coin);
  if (action === "link") return sendLinks(msg.chat.id, coin);
}

const RESERVED_COMMANDS = new Set([
  "start", "help", "rules", "price", "market", "vol", "supply", "bio",
  "link", "trending", "watch", "watchlist", "status", "block", "unblock"
]);

bot.onText(/^\/([a-z0-9]{2,15})(?:@\w+)?$/i, async (msg, match) => {
  const ticker = String(match?.[1] || "").toLowerCase();
  if (RESERVED_COMMANDS.has(ticker)) return;

  const coin = await resolveTicker(msg.chat.id, ticker);
  if (!coin) return;
  await sendCoinCard(msg.chat.id, coin);
});

bot.onText(/^\/price(?:@\w+)?(?:\s+(.+))?$/i, (msg, match) =>
  commandWithCoin(msg, match, "price")
);

bot.onText(/^\/market(?:@\w+)?(?:\s+(.+))?$/i, (msg, match) =>
  commandWithCoin(msg, match, "market")
);

bot.onText(/^\/vol(?:@\w+)?(?:\s+(.+))?$/i, (msg, match) =>
  commandWithCoin(msg, match, "vol")
);

bot.onText(/^\/supply(?:@\w+)?(?:\s+(.+))?$/i, (msg, match) =>
  commandWithCoin(msg, match, "supply")
);

bot.onText(/^\/bio(?:@\w+)?(?:\s+(.+))?$/i, (msg, match) =>
  commandWithCoin(msg, match, "bio")
);

bot.onText(/^\/link(?:@\w+)?(?:\s+(.+))?$/i, (msg, match) =>
  commandWithCoin(msg, match, "link")
);

bot.onText(/^\/trending(?:@\w+)?$/i, async msg => {
  try {
    const { data } = await paprika.get("/tickers", {
      params: { quotes: "USD", limit: 10 }
    });

    const coins = Array.isArray(data) ? data.slice(0, 10) : [];

    if (!coins.length) {
      return sendNotice(msg.chat.id, "⚠️ Market data is unavailable.");
    }

    const rows = coins.map((c, i) => {
      const usd = c.quotes?.USD || {};
      return `${i + 1}. <b>${escapeHtml(c.name)}</b> (${escapeHtml(
        c.symbol
      )}) • ${fmtMoney(usd.price)} • ${formatPercent(
        usd.percent_change_24h
      )}`;
    });

    await sendNotice(
      msg.chat.id,
      `🔥 <b>Top Market Cryptocurrencies</b>

${rows.join("\n")}

<i>🐋 Powered by WhalesCoin.</i>`
    );
  } catch (err) {
    console.log("Trending error:", err.response?.data || err.message);
    await sendNotice(msg.chat.id, "⚠️ Market data could not be loaded.");
  }
});

bot.onText(/^\/watch(?:@\w+)?(?:\s+([A-Za-z0-9$._-]+)\s+([0-9]+(?:\.[0-9]+)?))?$/i, async (msg, match) => {
  const query = (match?.[1] || "").trim();
  const percent = Number(match?.[2] || 0);

  if (!query || !percent || percent <= 0 || percent > 1000) {
    return sendNotice(
      msg.chat.id,
      `🔔 Use: <code>/watch BTC 5</code>\n\nThis creates an alert when BTC moves approximately ±5% from the saved price.`
    );
  }

  const coin = await resolveTicker(msg.chat.id, query);
  if (!coin) return;

  try {
    const market = await getTicker(coin.id);
    const usd = market?.quotes?.USD;

    if (!usd?.price) {
      return sendNotice(msg.chat.id, "⚠️ Current price is unavailable.");
    }

    const key = `${msg.chat.id}:${msg.from.id}:${coin.id}`;

    watchMap.set(key, {
      chatId: msg.chat.id,
      userId: msg.from.id,
      coinId: coin.id,
      symbol: coin.symbol,
      name: coin.name,
      basePrice: Number(usd.price),
      percent,
      createdAt: Date.now()
    });

    await sendNotice(
      msg.chat.id,
      `🔔 <b>Price Alert Created</b>

🪙 <b>${coinTitle(coin)}</b>
💰 Base price: ${fmtMoney(usd.price)}
🎯 Alert threshold: ±${percent}%

<i>Alert is stored in memory and resets if the Render service restarts.</i>`
    );
  } catch (err) {
    console.log("Watch error:", err.response?.data || err.message);
    await sendNotice(msg.chat.id, "⚠️ Could not create the alert.");
  }
});

bot.onText(/^\/watchlist(?:@\w+)?$/i, async msg => {
  const items = [...watchMap.values()].filter(
    item => item.chatId === msg.chat.id && item.userId === msg.from.id
  );

  if (!items.length) {
    return sendNotice(
      msg.chat.id,
      "📋 <b>Your Watchlist</b>\n\nNo active price alerts."
    );
  }

  const rows = items.map((item, i) => {
    return `${i + 1}. <b>${escapeHtml(item.name)} (${escapeHtml(
      item.symbol
    )})</b> — ±${item.percent}% from ${fmtMoney(item.basePrice)}`;
  });

  await sendNotice(
    msg.chat.id,
    `📋 <b>Your Watchlist</b>\n\n${rows.join("\n")}`
  );
});

bot.onText(/^\/status(?:@\w+)?$/i, async msg => {
  if (!(await isAdmin(msg.chat.id, msg.from.id))) return;

  const domains = ALLOWED_DOMAINS.length
    ? ALLOWED_DOMAINS.join(", ")
    : "None";

  await sendNotice(
    msg.chat.id,
    `✅ <b>Moderation System Active</b>

🔗 Unauthorized links: <b>Auto Ban</b>
🚨 Flood/spam: <b>Auto Restrict</b>
🧹 Policy violations: <b>Auto Delete</b>
👑 Admin protection: <b>Enabled</b>
💾 Database: <b>Not Used</b>
📊 Market API: <b>CoinPaprika</b>
🌐 Allowed domains: <code>${escapeHtml(domains)}</code>`
  );
});

bot.onText(/^\/block(?:@\w+)?$/i, async msg => {
  if (!(await isAdmin(msg.chat.id, msg.from.id))) return;

  const target = msg.reply_to_message?.from;

  if (!target) {
    return sendNotice(
      msg.chat.id,
      "ℹ️ Reply to a user's message with <code>/block</code>."
    );
  }

  if (await isAdmin(msg.chat.id, target.id)) {
    return sendNotice(
      msg.chat.id,
      "⚠️ Administrators cannot be blocked by this command."
    );
  }

  const ok = await banUser(msg.chat.id, target.id);

  if (ok) {
    await safeDelete(msg.chat.id, msg.message_id);
    await sendNotice(
      msg.chat.id,
      `🚫 <b>User Banned</b>

👤 User: ${displayUser(target)}
🛡️ Action: <b>Removed by administrator</b>`
    );
  }
});

bot.onText(/^\/unblock(?:@\w+)?(?:\s+(\d+))?$/i, async (msg, match) => {
  if (!(await isAdmin(msg.chat.id, msg.from.id))) return;

  const targetId = Number(match?.[1] || 0);

  if (!targetId) {
    return sendNotice(
      msg.chat.id,
      "ℹ️ Use: <code>/unblock TELEGRAM_USER_ID</code>"
    );
  }

  try {
    await bot.unbanChatMember(msg.chat.id, targetId, {
      only_if_banned: true
    });

    await sendNotice(
      msg.chat.id,
      `✅ User <code>${targetId}</code> has been unblocked.`
    );
  } catch {
    await sendNotice(msg.chat.id, "⚠️ Unable to unblock this user.");
  }
});

// Inline button callbacks
bot.on("callback_query", async query => {
  const data = query.data || "";

  try {
    if (data === "global:trending") {
      await bot.answerCallbackQuery(query.id, { text: "Loading trending coins…" });
      const { data: tickers } = await paprika.get("/tickers", {
        params: { quotes: "USD", limit: 10 }
      });
      const rows = (tickers || []).slice(0, 10).map((c, i) => {
        const usd = c?.quotes?.USD || {};
        const change = Number(usd.percent_change_24h || 0);
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        return `${medal} <b>${escapeHtml(c.symbol || "")}</b> • ${fmtMoney(usd.price)} • ${changeIcon(change)} ${formatPercent(change)}`;
      });
      return sendNotice(query.message.chat.id, `🔥 <b>Trending Market</b>

${rows.join("\n")}

<i>🐋 WhalesCoin • Live Market Data</i>`);
    }

    if (!data.startsWith("coin:")) return;

    const [, action, coinId] = data.split(":");
    await bot.answerCallbackQuery(query.id, { text: action === "refresh" ? "Refreshed ✓" : "Loading…" });

    const coin = await getCoinInfo(coinId);
    await updateCoinCard(query, coin, action === "menu" ? "refresh" : action);
  } catch (err) {
    const message = String(err.message || "");
    if (!message.includes("message is not modified")) {
      console.log("Callback error:", err.response?.data || err.message);
    }
    try {
      await bot.answerCallbackQuery(query.id, {
        text: message.includes("message is not modified") ? "Already up to date ✓" : "Data temporarily unavailable.",
        show_alert: false
      });
    } catch {}
  }
});

// Automatic moderation
bot.on("message", async msg => {
  if (!msg.chat || !["group", "supergroup"].includes(msg.chat.type)) return;
  if (!msg.from || msg.from.is_bot) return;

  const text = normalizeText(msg);

  if (text.startsWith("/")) return;

  if (await isAdmin(msg.chat.id, msg.from.id)) return;

  if (containsUrl(text) && !urlIsAllowed(text)) {
    await safeDelete(msg.chat.id, msg.message_id);
    const banned = await banUser(msg.chat.id, msg.from.id);

    if (banned) {
      await sendNotice(
        msg.chat.id,
        `🚨 <b>Security Action</b>

👤 User: ${displayUser(msg.from)}
🔗 Reason: <b>Unauthorized external link</b>
🛡️ Action: <b>User removed from the community</b>

<i>Promotional, referral and suspicious links are not permitted.</i>`
      );
    }
    return;
  }

  if (containsBlockedLanguage(text)) {
    await safeDelete(msg.chat.id, msg.message_id);
    const count = addViolation(msg.chat.id, msg.from.id);

    if (count >= 2) {
      const banned = await banUser(msg.chat.id, msg.from.id);

      if (banned) {
        await sendNotice(
          msg.chat.id,
          `🚫 <b>Moderation Action</b>

👤 User: ${displayUser(msg.from)}
⚠️ Reason: <b>Repeated prohibited content</b>
🛡️ Action: <b>User banned</b>`
        );
      }
    } else {
      await restrictUser(msg.chat.id, msg.from.id, 600);

      await sendNotice(
        msg.chat.id,
        `⚠️ <b>Community Guidelines</b>

${displayUser(msg.from)}, your message was removed for violating the community policy.

🔇 You have been temporarily restricted.
Please keep all discussion respectful and professional.`
      );
    }
    return;
  }

  if (isFlooding(msg.chat.id, msg.from.id)) {
    await safeDelete(msg.chat.id, msg.message_id);
    await restrictUser(msg.chat.id, msg.from.id, 600);

    await sendNotice(
      msg.chat.id,
      `⚠️ <b>Anti-Spam Protection</b>

${displayUser(msg.from)} has been temporarily restricted for excessive message flooding.

🛡️ Please avoid repetitive or rapid-fire messages.`
    );
  }
});

bot.on("new_chat_members", async msg => {
  if (!msg.new_chat_members?.length) return;

  const realMembers = msg.new_chat_members.filter(u => !u.is_bot);
  if (!realMembers.length) return;

  const names = realMembers.map(displayUser).join(", ");

  await sendNotice(
    msg.chat.id,
    `🐋 <b>Welcome to ${escapeHtml(BRAND_NAME)}</b>

Welcome ${names}.

📊 <code>/price BTC</code> for live price
🏦 <code>/market BTC</code> for exchanges
📈 <code>/vol BTC</code> for volume
💎 <code>/supply BTC</code> for supply
ℹ️ <code>/bio BTC</code> for coin information
🔗 <code>/link BTC</code> for official links

<i>Please note: unauthorized links and spam are automatically moderated.</i>`
  );
});

// Periodic price-alert checker.
// Memory only; alerts reset after a Render restart.
setInterval(async () => {
  for (const [key, alert] of watchMap.entries()) {
    try {
      const market = await getTicker(alert.coinId);
      const price = Number(market?.quotes?.USD?.price || 0);

      if (!price || !alert.basePrice) continue;

      const move =
        ((price - alert.basePrice) / alert.basePrice) * 100;

      if (Math.abs(move) >= alert.percent) {
        await sendNotice(
          alert.chatId,
          `🔔 <b>Price Alert</b>

🪙 <b>${escapeHtml(alert.name)} (${escapeHtml(
            alert.symbol
          )})</b>

💰 Current: ${fmtMoney(price)}
📊 Move: <b>${formatPercent(move)}</b>
🎯 Trigger: ±${alert.percent}%`

        );

        watchMap.delete(key);
      }
    } catch (err) {
      console.log("Alert check error:", err.message);
    }
  }
}, 5 * 60 * 1000);

// Webhook + Render
app.get("/", (_req, res) => {
  res.status(200).send(`${BRAND_NAME} bot is running.`);
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    bot: BRAND_NAME,
    database: false,
    market_api: "CoinPaprika",
    mode: "webhook"
  });
});

app.post(`/telegram/${WEBHOOK_SECRET}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server running on port ${PORT}`);

  try {
    await bot.setMyCommands(COMMANDS);
    console.log("Telegram command menu configured.");
  } catch (err) {
    console.error("Command menu setup failed:", err.message);
  }

  const externalUrl = process.env.RENDER_EXTERNAL_URL;

  if (!externalUrl) {
    console.log(
      "RENDER_EXTERNAL_URL not found. Webhook was not set automatically."
    );
    return;
  }

  try {
    const webhookUrl = `${externalUrl}/telegram/${WEBHOOK_SECRET}`;
    await bot.setWebHook(webhookUrl);
    console.log("Telegram webhook configured successfully.");
  } catch (err) {
    console.error("Webhook setup failed:", err.message);
  }
});
