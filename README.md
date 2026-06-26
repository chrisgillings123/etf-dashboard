# ETF Valuation Dashboard

A portfolio-manager–style dashboard tracking 12 ASX-listed ETFs with live prices, charts,
and an **Over / Fair / Under** valuation score for each holding.

Built as a static frontend (`index.html`, Chart.js) plus one Vercel serverless function
(`api/data.js`) that proxies **Yahoo Finance** (free, no API key) server-side to avoid CORS.

## What it shows

- **KPI strip** — ETFs tracked, average day move, advancers/decliners, count rich/fair/cheap.
- **Charts** — composite valuation z-score per ETF, and day-move bar chart.
- **Holdings table** — price, day %, 52-week range position, valuation vs 3/5/10-yr trend,
  underlying-index P/E and P/Rev snapshot, and a colour-coded score badge. Click any row for a
  price-history chart (1/3/5/10yr) and full stats.
- **Manual refresh** — data loads on page open and on the Refresh button (free-tier data may be delayed).

## ETF universe

| Ticker | ETF | Underlying index | Fundamentals proxy |
|---|---|---|---|
| IHVV | iShares S&P 500 (AUD Hedged) | S&P 500 | SPY |
| VGAD | Vanguard MSCI Intl Shares (Hedged) | MSCI World ex-Australia | URTH |
| HNDQ | Betashares Nasdaq 100 (Hedged) | Nasdaq-100 | QQQ |
| VAE | Vanguard FTSE Asia ex Japan | FTSE Asia Pac ex Japan/Aus/NZ | AAXJ |
| IEM | iShares MSCI Emerging Markets | MSCI Emerging Markets | EEM |
| SEMI | Global X Semiconductor | Solactive Global Semiconductor | SOXX |
| WIRE | Global X Copper Miners | Solactive Global Copper Miners | COPX |
| BNKS | Betashares Global Banks (Hedged) | Nasdaq Global ex-Aus Banks | IXG |
| FANG | Global X FANG+ | NYSE FANG+ | FNGS |
| FHNG | Global X FANG+ (Hedged) | NYSE FANG+ | FNGS |
| WXHG | SPDR S&P World ex-Aus Carbon Aware (Hedged) | S&P Developed ex-Aus Carbon Control | URTH |
| IHWL | iShares MSCI World ex-Aus ESG Leaders (Hedged) | MSCI World ex-Aus ESG Leaders | URTH |

## Valuation methodology

Free data sources do **not** provide multi-year P/E or P/Rev *history* at the ETF or index level,
so the scored signal is built from price, which is reliably available:

1. For each ETF, fit a log-linear trend to its own price history over **3, 5 and 10 years**
   (this captures the asset's normal upward drift).
2. Express today's price as a **z-score (σ) of the residuals** — how stretched it is versus its
   *own* long-run trend.
3. Composite = average of the available windows. Bands:
   - `≥ +1σ` → **Overvalued**, `≥ +0.4σ` → Mildly rich
   - `±0.4σ` → **Fair value**
   - `≤ −0.4σ` → Mildly cheap, `≤ −1σ` → **Undervalued**

**Index P/E & P/Rev** are shown as a *current snapshot* of each ETF's underlying index (via a
liquid US/global proxy ETF), where the free feed exposes them — context only, not a historical
comparison. Cells show "—" when unavailable.

> Not investment advice. Data is sourced from a free, unofficial endpoint and may be delayed or incomplete.

## Deploy

This repo deploys to Vercel with **zero configuration** — static files + `api/` serverless functions are auto-detected.

### Push to GitHub then connect Vercel

```bash
git init
git add .
git commit -m "ETF valuation dashboard"
git branch -M main
git remote add origin https://github.com/<your-username>/etf-valuation-dashboard.git
git push -u origin main
```

Then in Vercel: **Add New → Project → Import** the GitHub repo → **Deploy** (no build settings needed).
Every push to `main` redeploys automatically.

### Local preview

```bash
npm i -g vercel
vercel dev    # serves index.html + /api/data locally
```

## Project structure

```
.
├── index.html      # dashboard UI (Chart.js via CDN)
├── api/
│   └── data.js     # serverless function: Yahoo proxy + valuation engine
├── package.json
└── README.md
```
