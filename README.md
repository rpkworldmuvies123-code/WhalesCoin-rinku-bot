# WhalesCoin Premium Telegram Bot V2

Premium Telegram crypto UX with live market cards, same-message navigation, search, trending, watchlist, moderation and a separate bot-owner control center.

## Render
- Build: `npm install`
- Start: `npm start`
- Node: 20+

## Required environment
See `.env.example`.

## Telegram permissions
For group moderation the bot should be an administrator with Delete Messages and Ban/Restrict Users permissions.

## Note
This version intentionally uses no database. Watchlists, alerts and runtime staff/group state are memory-only unless configured through environment variables.
