require("dotenv").config();

const express = require("express");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "whalescoin-secure-webhook";
const BRAND_NAME = process.env.BRAND_NAME || "WhalesCoin Community";
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

// No database is used. These counters reset when Render restarts.
const floodMap = new Map();
const violationMap = new Map();

const URL_REGEX = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|[a-z0-9-]+\.(?:com|net|org|io|co|in|xyz|me|app|site|online|shop|info|biz|link|live|pro|ai)(?:\/|\b))/i;

const DEFAULT_BLOCKED_WORDS = [
  "scam link",
  "free usdt",
  "guaranteed profit",
  "double your money",
  "dm for investment"
];

const blockedWords = [...DEFAULT_BLOCKED_WORDS, ...EXTRA_BLOCKED_WORDS];

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function displayUser(user) {
  if (!user) return "Unknown";
  if (user.username) return `@${escapeHtml(user.username)}`;
  return `<a href="tg://user?id=${user.id}">${escapeHtml(user.first_name || "Member")}</a>`;
}

function normalizeText(msg) {
  return `${msg.text || ""} ${msg.caption || ""}`.trim();
}

function containsUrl(text) {
  return URL_REGEX.test(text || "");
}

function extractDomains(text) {
  const matches = (text || "").match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi) || [];
  return matches.map(raw => {
    try {
      const clean = raw.startsWith("http") ? raw : `https://${raw}`;
      return new URL(clean).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
    }
  });
}

function urlIsAllowed(text) {
  if (!containsUrl(text)) return true;
  if (ALLOWED_DOMAINS.length === 0) return false;

  const domains = extractDomains(text);
  if (!domains.length) return false;

  return domains.every(domain =>
    ALLOWED_DOMAINS.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`))
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

async function sendNotice(chatId, html, replyToMessageId = null) {
  try {
    const options = {
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    if (replyToMessageId) options.reply_to_message_id = replyToMessageId;
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
  const windowMs = 10000;
  const maxMessages = 7;

  const old = floodMap.get(key) || [];
  const recent = old.filter(ts => now - ts <= windowMs);
  recent.push(now);
  floodMap.set(key, recent);

  return recent.length > maxMessages;
}

// -------------------------
// CoinPaprika helpers
// -------------------------
const paprika = axios.create({
  baseURL: "https://api.coinpaprika.com/v1",
  timeout: 12000
});

async function findCoin(query) {
  const q = query.trim().toLowerCase();

  // Direct ticker/ID shortcuts for common assets.
  const shortcuts = {
    btc: "btc-bitcoin",
    bitcoin: "btc-bitcoin",
    eth: "eth-ethereum",
    ethereum: "eth-ethereum",
    bnb: "bnb-binance-coin",
    sol: "sol-solana",
    solana: "sol-solana",
    xrp: "xrp-xrp",
    doge: "doge-dogecoin",
    dogecoin: "doge-dogecoin",
    ada: "ada-cardano",
    cardano: "ada-cardano",
    trx: "trx-tron",
    tron: "trx-tron",
    dot: "dot-polkadot",
    shib: "shib-shiba-inu",
    "shiba inu": "shib-shiba-inu",
    avax: "avax-avalanche",
    link: "link-chainlink",
    matic: "matic-polygon",
    pol: "pol-polygon-ecosystem-token",
    pepe: "pepe-pepe"
  };

  if (shortcuts[q]) return { id: shortcuts[q], name: q, symbol: q.toUpperCase() };

  // If the user supplied a CoinPaprika ID directly.
  if (/^[a-z0-9]+-[a-z0-9-]+$/i.test(q)) {
    try {
      const { data } = await paprika.get(`/tickers/${encodeURIComponent(q)}`, { params: { quotes: "USD" } });
      if (data?.id) return data;
    } catch (_) {}
  }

  const { data } = await paprika.get("/search", { params: { q } });
  const currencies = data?.currencies || [];
  if (!currencies.length) return null;

  return (
    currencies.find(c => c.symbol?.toLowerCase() === q) ||
    currencies.find(c => c.id?.toLowerCase() === q) ||
    currencies.find(c => c.name?.toLowerCase() === q) ||
    currencies[0]
  );
}

async function getCoinMarket(coinId) {
  const { data } = await paprika.get(`/tickers/${encodeURIComponent(coinId)}`, {
    params: { quotes: "USD" }
  });
  return data || null;
}

function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "N/A";
  const num = Number(n);
  if (Math.abs(num) >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
  if (Math.abs(num) >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (Math.abs(num) >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (Math.abs(num) >= 1) return `$${num.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
  return `$${num.toLocaleString("en-US", { maximumFractionDigits: 10 })}`;
}

function changeIcon(value) {
  const n = Number(value || 0);
  return n >= 0 ? "🟢" : "🔴";
}

// -------------------------
// Commands
// -------------------------
bot.onText(/^\/start(?:@\w+)?$/i, async msg => {
  const text =
`🐋 <b>${escapeHtml(BRAND_NAME)}</b>

Welcome to the official market assistant.

📊 Live crypto prices
🔥 Top market cryptocurrencies
🛡️ Automated anti-spam protection
🔗 Unauthorized links are automatically removed

<b>Quick Commands</b>
<code>/price BTC</code> — Live price
<code>/trending</code> — Top market coins
<code>/rules</code> — Community rules
<code>/help</code> — Command list`;

  await sendNotice(msg.chat.id, text);
});

bot.onText(/^\/help(?:@\w+)?$/i, async msg => {
  const text =
`📋 <b>${escapeHtml(BRAND_NAME)} — Commands</b>

<b>Market</b>
<code>/price BTC</code> — Price, 24h change, market cap & volume
<code>/trending</code> — Top market crypto assets

<b>Community</b>
<code>/rules</code> — Group rules

<b>Admin</b>
<code>/block</code> — Reply to a user's message to ban
<code>/unblock USER_ID</code> — Unban by Telegram numeric ID
<code>/status</code> — Bot moderation status

<i>Admins are exempt from automatic moderation.</i>`;

  await sendNotice(msg.chat.id, text);
});

bot.onText(/^\/rules(?:@\w+)?$/i, async msg => {
  const text =
`🛡️ <b>Community Rules</b>

1. No unauthorized links, promotions or referrals.
2. No spam, flooding or repetitive messages.
3. No abusive, threatening or inappropriate content.
4. No fake giveaways, guaranteed-profit claims or scam promotion.
5. Respect members and administrators.

⚠️ Violations may result in message removal, temporary restriction or ban.`;

  await sendNotice(msg.chat.id, text);
});

bot.onText(/^\/price(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  const query = (match?.[1] || "").trim();

  if (!query) {
    return sendNotice(
      msg.chat.id,
      `ℹ️ Use: <code>/price BTC</code>\nExample: <code>/price ETH</code>`
    );
  }

  try {
    const coin = await findCoin(query);
    if (!coin) {
      return sendNotice(msg.chat.id, `❌ Coin not found: <b>${escapeHtml(query)}</b>`);
    }

    const m = await getCoinMarket(coin.id);
    if (!m?.quotes?.USD) {
      return sendNotice(msg.chat.id, `⚠️ Market data is temporarily unavailable.`);
    }

    const usd = m.quotes.USD;
    const ch = Number(usd.percent_change_24h || 0);
    const text =
`📊 <b>${escapeHtml(m.name)} (${escapeHtml(m.symbol.toUpperCase())})</b>

💰 <b>Price:</b> ${fmtMoney(usd.price)}
${changeIcon(ch)} <b>24h:</b> ${ch.toFixed(2)}%
🏦 <b>Market Cap:</b> ${fmtMoney(usd.market_cap)}
📈 <b>24h Volume:</b> ${fmtMoney(usd.volume_24h)}
🔼 <b>24h High:</b> ${fmtMoney(usd.price_high_24h)}
🔽 <b>24h Low:</b> ${fmtMoney(usd.price_low_24h)}

<i>Market data powered by CoinPaprika.</i>`;

    await sendNotice(msg.chat.id, text);
  } catch (err) {
    console.log("Price error:", err.response?.data || err.message);
    await sendNotice(
      msg.chat.id,
      `⚠️ Market data could not be loaded right now. Please try again shortly.`
    );
  }
});

bot.onText(/^\/trending(?:@\w+)?$/i, async msg => {
  try {
    // CoinPaprika does not provide a dedicated free "trending" endpoint.
    // We show the top-ranked market assets instead.
    const { data } = await paprika.get("/tickers", {
      params: { quotes: "USD", limit: 7 }
    });
    const coins = (data || []).slice(0, 7);

    if (!coins.length) {
      return sendNotice(msg.chat.id, "⚠️ Market data is temporarily unavailable.");
    }

    const rows = coins.map((c, i) => {
      const rank = c.rank ? `#${c.rank}` : "—";
      const ch = Number(c.quotes?.USD?.percent_change_24h || 0);
      return `${i + 1}. <b>${escapeHtml(c.name)}</b> (${escapeHtml(c.symbol)}) • ${rank} • ${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`;
    });

    await sendNotice(
      msg.chat.id,
      `🔥 <b>Top Market Cryptocurrencies</b>\n\n${rows.join("\n")}\n\n<i>Market data powered by CoinPaprika.</i>`
    );
  } catch (err) {
    console.log("Trending error:", err.response?.data || err.message);
    await sendNotice(msg.chat.id, "⚠️ Market data could not be loaded right now.");
  }
});

bot.onText(/^\/status(?:@\w+)?$/i, async msg => {
  if (!(await isAdmin(msg.chat.id, msg.from.id))) return;

  const domains = ALLOWED_DOMAINS.length ? ALLOWED_DOMAINS.join(", ") : "None";
  await sendNotice(
    msg.chat.id,
`✅ <b>Moderation System Active</b>

🔗 Unauthorized links: <b>Auto Ban</b>
🚨 Flood/spam: <b>Auto Restrict</b>
🧹 Policy violations: <b>Auto Delete</b>
👑 Admin protection: <b>Enabled</b>
💾 Database: <b>Not Used</b>
🌐 Allowed domains: <code>${escapeHtml(domains)}</code>`
  );
});

bot.onText(/^\/block(?:@\w+)?$/i, async msg => {
  if (!(await isAdmin(msg.chat.id, msg.from.id))) return;

  const target = msg.reply_to_message?.from;
  if (!target) {
    return sendNotice(msg.chat.id, "ℹ️ Reply to a user's message with <code>/block</code>.");
  }

  if (await isAdmin(msg.chat.id, target.id)) {
    return sendNotice(msg.chat.id, "⚠️ Administrators cannot be blocked by this command.");
  }

  const ok = await banUser(msg.chat.id, target.id);
  if (ok) {
    await safeDelete(msg.chat.id, msg.message_id);
    await sendNotice(
      msg.chat.id,
      `🚫 <b>User Banned</b>\n\n👤 User: ${displayUser(target)}\n🛡️ Action: <b>Removed by administrator</b>`
    );
  }
});

bot.onText(/^\/unblock(?:@\w+)?(?:\s+(\d+))?$/i, async (msg, match) => {
  if (!(await isAdmin(msg.chat.id, msg.from.id))) return;

  const targetId = Number(match?.[1] || 0);
  if (!targetId) {
    return sendNotice(msg.chat.id, "ℹ️ Use: <code>/unblock TELEGRAM_USER_ID</code>");
  }

  try {
    await bot.unbanChatMember(msg.chat.id, targetId, { only_if_banned: true });
    await sendNotice(msg.chat.id, `✅ User <code>${targetId}</code> has been unblocked.`);
  } catch (err) {
    await sendNotice(msg.chat.id, `⚠️ Unable to unblock this user.`);
  }
});

// -------------------------
// Automatic moderation
// -------------------------
bot.on("message", async msg => {
  if (!msg.chat || !["group", "supergroup"].includes(msg.chat.type)) return;
  if (!msg.from || msg.from.is_bot) return;

  const text = normalizeText(msg);
  if (text.startsWith("/")) return;
  if (await isAdmin(msg.chat.id, msg.from.id)) return;

  // Unauthorized links => delete + ban
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

  // Scam / prohibited phrases => delete, then restrict/ban on repeat
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

  // Flood protection => delete + temporary restriction
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

📊 Use <code>/price BTC</code> for live market data.
🔥 Use <code>/trending</code> for top market assets.
🛡️ Use <code>/rules</code> to read the community guidelines.

<i>Please note: unauthorized links and spam are automatically moderated.</i>`
  );
});

// -------------------------
// Webhook + Render
// -------------------------
app.get("/", (_req, res) => {
  res.status(200).send(`${BRAND_NAME} bot is running.`);
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    bot: BRAND_NAME,
    database: false,
    market_data: "CoinPaprika",
    mode: "webhook"
  });
});

app.post(`/telegram/${WEBHOOK_SECRET}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server running on port ${PORT}`);

  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) {
    console.log("RENDER_EXTERNAL_URL not found. Webhook was not set automatically.");
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
