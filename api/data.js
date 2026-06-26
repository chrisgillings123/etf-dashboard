// Vercel serverless function: fetches live ETF data from Yahoo Finance (server-side,
// no CORS issues) and computes price stats + a valuation score for each ETF.
//
// Endpoints:
//   GET /api/data            -> all ETFs, summary + downsampled price history
//   GET /api/data?ticker=X   -> single ETF with full daily history (for detail charts)

// ---- ETF universe -> underlying index + liquid US/global proxy for fundamentals ----
const ETFS = [
  { ticker: "IHVV.AX", name: "iShares S&P 500 (AUD Hedged)",                     index: "S&P 500",                              proxy: "SPY",  group: "Broad / Developed" },
  { ticker: "VGAD.AX", name: "Vanguard MSCI Intl Shares (Hedged)",               index: "MSCI World ex-Australia",              proxy: "URTH", group: "Broad / Developed" },
  { ticker: "HNDQ.AX", name: "Betashares Nasdaq 100 (Hedged)",                   index: "Nasdaq-100",                           proxy: "QQQ",  group: "Broad / Developed" },
  { ticker: "VAE.AX",  name: "Vanguard FTSE Asia ex Japan",                      index: "FTSE Asia Pacific ex Japan/Aus/NZ",    proxy: "AAXJ", group: "Regional / EM" },
  { ticker: "IEM.AX",  name: "iShares MSCI Emerging Markets",                    index: "MSCI Emerging Markets",                proxy: "EEM",  group: "Regional / EM" },
  { ticker: "SEMI.AX", name: "Global X Semiconductor",                           index: "Solactive Global Semiconductor",       proxy: "SOXX", group: "Thematic / Sector" },
  { ticker: "WIRE.AX", name: "Global X Copper Miners",                           index: "Solactive Global Copper Miners",       proxy: "COPX", group: "Thematic / Sector" },
  { ticker: "BNKS.AX", name: "Betashares Global Banks (Hedged)",                 index: "Nasdaq Global ex-Aus Banks",           proxy: "IXG",  group: "Thematic / Sector" },
  { ticker: "FANG.AX", name: "Global X FANG+",                                   index: "NYSE FANG+",                           proxy: "FNGS", group: "Thematic / Sector" },
  { ticker: "FHNG.AX", name: "Global X FANG+ (Hedged)",                          index: "NYSE FANG+",                           proxy: "FNGS", group: "Thematic / Sector" },
  { ticker: "WXHG.AX", name: "SPDR S&P World ex-Aus Carbon Aware (Hedged)",      index: "S&P Developed ex-Aus Carbon Control",  proxy: "URTH", group: "ESG / Climate" },
  { ticker: "IHWL.AX", name: "iShares MSCI World ex-Aus ESG Leaders (Hedged)",   index: "MSCI World ex-Aus ESG Leaders",        proxy: "URTH", group: "ESG / Climate" },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// Yahoo chart -> { meta, points:[{t, c}] }
async function fetchChart(symbol, range = "10y", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const j = await fetchJson(url);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`No chart data for ${symbol}`);
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const adj = res.indicators?.adjclose?.[0]?.adjclose || null;
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const c = (adj && adj[i] != null) ? adj[i] : closes[i];
    if (c != null && isFinite(c)) points.push({ t: ts[i] * 1000, c });
  }
  return { meta: res.meta || {}, points };
}

// Best-effort current fundamentals (trailing P/E, price/sales) for the proxy index ETF.
// Yahoo's quoteSummary increasingly needs a crumb; we try and fail gracefully.
async function fetchFundamentals(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const j = await fetchJson(url);
    const q = j?.quoteResponse?.result?.[0];
    if (!q) return { pe: null, ps: null };
    return {
      pe: (q.trailingPE != null && isFinite(q.trailingPE)) ? q.trailingPE : null,
      ps: (q.priceToSales != null && isFinite(q.priceToSales)) ? q.priceToSales : null,
    };
  } catch {
    return { pe: null, ps: null };
  }
}

// --- valuation engine ---------------------------------------------------------
// For a window of N years, fit ln(price) ~ a + b*t (the asset's normal drift),
// then express today's price as a z-score of the regression residuals.
// +ve => price is above its long-run trend (richer); -ve => below trend (cheaper).
function trendZScore(points, years) {
  const cutoff = Date.now() - years * 365.25 * 24 * 3600 * 1000;
  const w = points.filter(p => p.t >= cutoff && p.c > 0);
  if (w.length < 30) return null;
  const xs = w.map(p => p.t / (365.25 * 24 * 3600 * 1000)); // years
  const ys = w.map(p => Math.log(p.c));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  const resid = ys.map((y, i) => y - (a + b * xs[i]));
  const mr = resid.reduce((s, r) => s + r, 0) / n;
  const sd = Math.sqrt(resid.reduce((s, r) => s + (r - mr) ** 2, 0) / n) || 1e-9;
  const last = resid[resid.length - 1];
  return (last - mr) / sd;
}

function scoreFromZ(z) {
  if (z == null) return { label: "n/a", tone: "na" };
  if (z >= 1.0)  return { label: "Overvalued",  tone: "over" };
  if (z <= -1.0) return { label: "Undervalued", tone: "under" };
  if (z >= 0.4)  return { label: "Mildly rich", tone: "mildover" };
  if (z <= -0.4) return { label: "Mildly cheap", tone: "milunder" };
  return { label: "Fair value", tone: "fair" };
}

function pct(a, b) { return (b ? (a - b) / b * 100 : null); }

function summarise(meta, points) {
  const last = points[points.length - 1];
  const price = (meta.regularMarketPrice != null) ? meta.regularMarketPrice : (last ? last.c : null);
  const prev = (meta.chartPreviousClose ?? meta.previousClose);
  const dayChgPct = (price != null && prev) ? pct(price, prev) : (points.length >= 2 ? pct(price, points[points.length - 2].c) : null);
  const hi = meta.fiftyTwoWeekHigh ?? Math.max(...points.slice(-252).map(p => p.c));
  const lo = meta.fiftyTwoWeekLow ?? Math.min(...points.slice(-252).map(p => p.c));
  const z3 = trendZScore(points, 3), z5 = trendZScore(points, 5), z10 = trendZScore(points, 10);
  const zs = [z3, z5, z10].filter(z => z != null);
  const composite = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null;
  return {
    price, currency: meta.currency || "AUD", dayChgPct,
    week52High: hi, week52Low: lo,
    pctFromHigh: hi ? pct(price, hi) : null,
    rangePos: (hi != null && lo != null && hi !== lo) ? (price - lo) / (hi - lo) * 100 : null,
    z3, z5, z10, composite,
    score: scoreFromZ(composite),
  };
}

// downsample to ~weekly for the overview payload
function downsample(points, every = 5) {
  const out = [];
  for (let i = 0; i < points.length; i += every) out.push(points[i]);
  if (points.length && out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  const single = req.query?.ticker;
  try {
    if (single) {
      const meta = ETFS.find(e => e.ticker === single);
      const { meta: m, points } = await fetchChart(single, "10y", "1d");
      const fund = meta ? await fetchFundamentals(meta.proxy) : { pe: null, ps: null };
      return res.status(200).json({
        ...meta, ...summarise(m, points), fundamentals: fund,
        history: points, asOf: Date.now(),
      });
    }

    // overview: fetch all in parallel; dedupe proxy fundamentals
    const proxies = [...new Set(ETFS.map(e => e.proxy))];
    const fundEntries = await Promise.all(proxies.map(async p => [p, await fetchFundamentals(p)]));
    const fundMap = Object.fromEntries(fundEntries);

    const rows = await Promise.allSettled(ETFS.map(async e => {
      const { meta, points } = await fetchChart(e.ticker, "10y", "1d");
      const s = summarise(meta, points);
      return { ...e, ...s, fundamentals: fundMap[e.proxy] || { pe: null, ps: null }, history: downsample(points, 5) };
    }));

    const data = rows.map((r, i) => r.status === "fulfilled" ? r.value
      : { ...ETFS[i], error: String(r.reason?.message || r.reason) });

    return res.status(200).json({ asOf: Date.now(), etfs: data });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
