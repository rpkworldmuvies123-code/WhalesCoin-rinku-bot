# WhalesCoin Professional Telegram Group Bot

No MongoDB or other database is required.

## Features

- Telegram group/supergroup support
- Professional welcome and moderation messages
- `/price BTC` live crypto market data
- `/trending`
- `/rules`
- `/help`
- `/block` by replying to a member
- `/unblock USER_ID`
- `/status` for admins
- Unauthorized links: auto-delete + auto-ban
- Flood protection: temporary restriction
- Configurable prohibited phrases
- Admins are exempt from automatic moderation
- Render-compatible webhook mode
- `/health` endpoint
- CoinGecko integration
- No persistent user data

## 1. Upload to GitHub

Upload these files to your GitHub repository:

- `index.js`
- `package.json`
- `.gitignore`
- `.env.example`
- `README.md`

Do **not** upload a real `.env` file or any secret token.

## 2. Render setup

Create a **Web Service** on Render and connect the GitHub repository.

- Build Command: `npm install`
- Start Command: `npm start`
- Instance: Free is okay for testing

## 3. Render Environment Variables

Add these in Render → Environment:

### Required

`BOT_TOKEN`
- Your NEW BotFather token.
- Never paste it into GitHub.

`TELEGRAM_WEBHOOK_SECRET`
- Any long random private string.
- Example format: `whalescoin-2026-x8k4m2p9-secret`

### Optional

`COINGECKO_API_KEY`
- Your CoinGecko Demo API key.
- Leave empty if your CoinGecko requests work without one.

`BRAND_NAME`
- Example: `WhalesCoin Community`

`ALLOWED_DOMAINS`
- Comma-separated domains members are allowed to post.
- Example: `whalescoin.com,x.com`
- Leave empty to block all external links from normal members.

`BLOCKED_WORDS`
- Extra phrases to remove/restrict.
- Comma-separated.

## 4. Give the bot Admin permissions in Telegram

The bot needs:

- Delete messages
- Ban users
- Restrict users
- Invite users (optional)

Without these permissions, automatic moderation cannot work.

## 5. Bot commands

- `/start`
- `/help`
- `/price BTC`
- `/trending`
- `/rules`
- `/status`
- `/block` — reply to a member
- `/unblock USER_ID`

## Important

This bot stores no user database.

Flood/violation counters are held temporarily in RAM and reset when the Render service restarts.

If you previously exposed a BotFather token, revoke it in BotFather and use a new token.