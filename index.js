require("dotenv").config();

const express = require("express");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = process.env.BOT_TOKEN;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "whalescoin-secure-webhook";
const BRAND_NAME = process.env.BRAND_NAME || "WhalesCoin Community";
const PORT = process.env.PORT || 10000;

// Optional: comma-separated domains that members are allowed to post.
// Example: whalescoin.com,x.com,twitter.com
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "")
  .split(",")
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);

// Optional custom blocked words, comma-separated.
// Keep this list specific to your own community rules.
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

// -------------------------
// In-memory anti-spam state
// -------------------------
// No database is used. These counters reset whenever Render restarts.
const floodMap = new Map();
const violationMap = new Map();

const URL_REGEX = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|[a-z0-9-]+\.(?:com|net|org|io|co|in|xyz|me|app|site|online|shop|info|biz|link|live|pro|ai)(?:\/|\b))/i;

const DEFAULT_BLOCKED_WORDS = [
  // Add/remove words according to your community policy.
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
    ALLOWED_DOMAINS.some(allowed =>
      domain === allowed || domain.endsWith(`.${allowed}`)
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
  const windowMs = 10_000;
  const maxMessages = 7;

  const old = floodMap.get(key) || [];
  const recent = old.filter(ts => now - ts <= windowMs);
  recent.push(now);
  floodMap.set(key, recent);

  return recent.length > maxMessages;
}

// -------------------------
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
      return sendNotice(
        msg.chat.id,
        `❌ Coin not found: <b>${escapeHtml(query)}</b>`
      );
    }

    const market = await getCoinMarket(coin.id);
    const usd = market?.quotes?.USD;

    if (!usd) {
      return sendNotice(
        msg.chat.id,
        `⚠️ Market data is temporarily unavailable.`
      );
    }

    const change = Number(usd.percent_change_24h || 0);

    const text =
`📊 <b>${escapeHtml(market.name)} (${escapeHtml(market.symbol)})</b>

💰 <b>Price:</b> ${fmtMoney(usd.price)}

${changeIcon(change)} <b>24h Change:</b> ${change.toFixed(2)}%

🏦 <b>Market Cap:</b> ${fmtMoney(usd.market_cap)}

📈 <b>24h Volume:</b> ${fmtMoney(usd.volume_24h)}

🏆 <b>Rank:</b> #${market.rank || "N/A"}

<i>Market data powered by CoinPaprika.</i>`;

    await sendNotice(msg.chat.id, text);

  } catch (err) {
    console.log(
      "CoinPaprika error:",
      err.response?.data || err.message
    );

    await sendNotice(
      msg.chat.id,
      `⚠️ Market data could not be loaded right now. Please try again shortly.`
    );
  }
});
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
🔥 Trending cryptocurrencies
🛡️ Automated anti-spam protection
🔗 Unauthorized links are automatically removed

<b>Quick Commands</b>
<code>/price BTC</code> — Live price
<code>/trending</code> — Trending coins
<code>/rules</code> — Community rules
<code>/help</code> — Command list`;

  await sendNotice(msg.chat.id, text);
});

bot.onText(/^\/help(?:@\w+)?$/i, async msg => {
  const text =
`📋 <b>${escapeHtml(BRAND_NAME)} — Commands</b>

<b>Market</b>
<code>/price BTC</code> — Price, 24h change, market cap & volume
<code>/trending</code> — Trending crypto assets

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
    if (!m) {
      return sendNotice(msg.chat.id, `⚠️ Market data is temporarily unavailable.`);
    }

    const ch = Number(m.price_change_percentage_24h || 0);
    const text =
`📊 <b>${escapeHtml(m.name)} (${escapeHtml(m.symbol.toUpperCase())})</b>

💰 <b>Price:</b> ${fmtMoney(m.current_price)}
${changeIcon(ch)} <b>24h:</b> ${ch.toFixed(2)}%
🏦 <b>Market Cap:</b> ${fmtMoney(m.market_cap)}
📈 <b>24h Volume:</b> ${fmtMoney(m.total_volume)}
🔼 <b>24h High:</b> ${fmtMoney(m.high_24h)}
🔽 <b>24h Low:</b> ${fmtMoney(m.low_24h)}

<i>Market data powered by CoinGecko.</i>`;

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
    const { data } = await cg.get("/search/trending");
    const coins = (data?.coins || []).slice(0, 7);

    if (!coins.length) {
      return sendNotice(msg.chat.id, "⚠️ Trending data is temporarily unavailable.");
    }

    const rows = coins.map((entry, i) => {
      const c = entry.item;
      const rank = c.market_cap_rank ? `#${c.market_cap_rank}` : "—";
      return `${i + 1}. <b>${escapeHtml(c.name)}</b> (${escapeHtml(c.symbol)}) • Rank ${rank}`;
    });

    await sendNotice(
      msg.chat.id,
      `🔥 <b>Trending Cryptocurrencies</b>\n\n${rows.join("\n")}\n\n<i>Powered by CoinGecko.</i>`
    );
  } catch (err) {
    console.log("Trending error:", err.response?.data || err.message);
    await sendNotice(msg.chat.id, "⚠️ Trending data could not be loaded right now.");
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

// Reply to a user's message with /block
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

// /unblock 123456789
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

  // Commands are handled separately.
  if (text.startsWith("/")) return;

  // Never auto-moderate admins/owner.
  if (await isAdmin(msg.chat.id, msg.from.id)) return;

  // 1) Unauthorized links => delete + ban
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

  // 2) Scam / prohibited phrases => delete, then restrict/ban on repeat
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

  // 3) Flood protection => delete + temporary restriction
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

// New member welcome message
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
🔥 Use <code>/trending</code> for trending assets.
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
