# WhalesCoin Professional Bot v4.0

CoinPaprika-only market data bot. No MongoDB.

## Market API
- Base: https://api.coinpaprika.com/v1
- Live ticker: /tickers/{coin_id}
- Latest OHLCV: /coins/{coin_id}/ohlcv/latest
- Markets: /coins/{coin_id}/markets
- Coin info: /coins/{coin_id}
- Search: /search?q={query}&c=currencies

## Test after Render deploy
Open:
https://YOUR-RENDER-SERVICE.onrender.com/market-test

It returns live BTC price, 24h change, OHLCV high/low, volume and market cap.

No API key is required for the free CoinPaprika REST endpoints used here.
