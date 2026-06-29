// Vercel serverless function — ETF valuation dashboard data API.
//
// Valuation (mean-reverting, multiples-based) applies to the broad/regional ETFs:
//   score = how far today's index P/E sits from its OWN trailing 3/5/10-yr average
//           P/E, in standard deviations (z). z<0 cheap vs history, z>0 rich.
//   Source: worldperatio.com (P/E + 3/5/10/20-yr mean & sigma per index).
// Sector/thematic ETFs: price-only (free data can't value these baskets reliably).
// Leveraged ETFs: price-only (gearing distorts multiples).
// Watchlist (user-added) tickers: price + current P/E / P/Rev (no history score).
//
// Prices, day move, 52-wk range, all-time-high drawdown and charts: Yahoo Finance.

const ETFS = [
  // Tier 1 — worldperatio valuation
  { ticker:"IHVV.AX", name:"iShares S&P 500 (AUD Hedged)",                   index:"S&P 500",                            group:"Broad / Developed", tier:1, wpr:"https://worldperatio.com/index/sp-500" },
  { ticker:"HNDQ.AX", name:"Betashares Nasdaq 100 (Hedged)",                 index:"Nasdaq-100",                         group:"Broad / Developed", tier:1, wpr:"https://worldperatio.com/index/nasdaq-100" },
  { ticker:"VGAD.AX", name:"Vanguard MSCI Intl Shares (Hedged)",             index:"MSCI World ex-Australia",            group:"Broad / Developed", tier:1, wpr:"https://worldperatio.com/area/msci-world" },
  { ticker:"WXHG.AX", name:"SPDR S&P World ex-Aus Carbon Aware (Hedged)",    index:"S&P Developed ex-Aus (~MSCI World)", group:"ESG / Climate",     tier:1, wpr:"https://worldperatio.com/area/msci-world" },
  { ticker:"IHWL.AX", name:"iShares MSCI World ex-Aus ESG Leaders (Hedged)", index:"MSCI World ESG (~MSCI World)",       group:"ESG / Climate",     tier:1, wpr:"https://worldperatio.com/area/msci-world" },
  { ticker:"IEM.AX",  name:"iShares MSCI Emerging Markets",                  index:"MSCI Emerging Markets",              group:"Regional / EM",     tier:1, wpr:"https://worldperatio.com/area/emerging-markets" },
  { ticker:"VAE.AX",  name:"Vanguard FTSE Asia ex Japan",                    index:"FTSE Asia Pac ex Japan",             group:"Regional / EM",     tier:1, wpr:"https://worldperatio.com/area/asia-ex-japan" },
  // Tier 2 — sector/thematic, price only
  { ticker:"SEMI.AX", name:"Global X Semiconductor",          index:"Solactive Global Semiconductor 30", group:"Thematic / Sector", tier:2 },
  { ticker:"WIRE.AX", name:"Global X Copper Miners",          index:"Solactive Global Copper Miners",    group:"Thematic / Sector", tier:2 },
  { ticker:"BNKS.AX", name:"Betashares Global Banks (Hedged)", index:"Nasdaq Global ex-Aus Banks",       group:"Thematic / Sector", tier:2 },
  { ticker:"FANG.AX", name:"Global X FANG+",                  index:"NYSE FANG+",                         group:"Thematic / Sector", tier:2 },
  { ticker:"FHNG.AX", name:"Global X FANG+ (Hedged)",         index:"NYSE FANG+",                         group:"Thematic / Sector", tier:2 },
  // Leveraged — price only
  { ticker:"GGBL.AX", name:"Betashares Geared Global Equity (Hedged)", index:"Geared global equities (~2x)", group:"Leveraged", tier:0 },
  { ticker:"GNDQ.AX", name:"Betashares Geared Nasdaq 100 (Hedged)",    index:"Geared Nasdaq-100 (~2x)",      group:"Leveraged", tier:0 },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function getJson(url){
  const r = await fetch(url, { headers:{ "User-Agent":UA, "Accept":"application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function getText(url){
  const r = await fetch(url, { headers:{ "User-Agent":UA, "Accept":"text/html" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

// Yahoo fundamentals (P/E, P/S) needs a cookie+crumb; often works for liquid names.
async function getCrumb(){
  const r1 = await fetch("https://fc.yahoo.com", { headers:{ "User-Agent":UA } });
  const sc = (typeof r1.headers.getSetCookie==="function" ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie")]).filter(Boolean);
  const cookie = sc.map(x=>String(x).split(";")[0]).join("; ");
  const cr = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers:{ "User-Agent":UA, "Cookie":cookie } });
  const crumb = (await cr.text()).trim();
  return { cookie, crumb };
}
async function fetchQuotes(symbols){
  const out = {};
  if (!symbols.length) return out;
  try {
    const { cookie, crumb } = await getCrumb();
    const url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + symbols.map(encodeURIComponent).join(",") + (crumb?("&crumb="+encodeURIComponent(crumb)):"");
    const r = await fetch(url, { headers:{ "User-Agent":UA, "Cookie":cookie, "Accept":"application/json" } });
    if (!r.ok) throw new Error("HTTP "+r.status);
    const j = await r.json();
    for (const q of (j && j.quoteResponse && j.quoteResponse.result) || []){
      out[q.symbol] = {
        pe: isFinite(q.trailingPE) ? q.trailingPE : null,
        ps: isFinite(q.priceToSalesTrailing12Months) ? q.priceToSalesTrailing12Months : (isFinite(q.priceToSales) ? q.priceToSales : null),
      };
    }
  } catch (e) { /* blocked -> leave empty */ }
  return out;
}

async function fetchChart(symbol, range, interval){
  const j = await getJson("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=" + range + "&interval=" + interval);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error("no chart");
  const ts = res.timestamp || [];
  const cl = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  const adj = (res.indicators && res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose) || null;
  const points = [];
  for (let i=0;i<ts.length;i++){ const c=(adj&&adj[i]!=null)?adj[i]:cl[i]; if(c!=null&&isFinite(c)) points.push({t:ts[i]*1000,c}); }
  return { meta:res.meta||{}, points };
}

function pct(a,b){ return b ? (a-b)/b*100 : null; }

function band(z){
  if (z==null) return { label:"n/a", tone:"na" };
  if (z<=-2) return { label:"Cheap",        tone:"cheap" };
  if (z<=-1) return { label:"Undervalued",  tone:"under" };
  if (z<  1) return { label:"Fair value",   tone:"fair" };
  if (z<  2) return { label:"Overvalued",   tone:"over" };
  return        { label:"Expensive",    tone:"exp" };
}

function stripHtml(html){
  return html.replace(/<script[\s\S]*?<\/script>/gi," ")
             .replace(/<style[\s\S]*?<\/style>/gi," ")
             .replace(/<[^>]+>/g," ")
             .replace(/&[a-z]+;/gi," ")
             .replace(/\s+/g," ");
}
async function fetchWPR(url){
  const txt = stripHtml(await getText(url));
  let pe = null;
  const peM = txt.match(/P\/E Ratio[^\d]{0,12}(\d{1,3}\.\d{1,2})/);
  if (peM) pe = parseFloat(peM[1]);
  const dateM = txt.match(/(\d{1,2}\s+\w+\s+20\d\d)/);
  const periods = {};
  for (const n of [3,5,10]){
    const m = txt.match(new RegExp("Last\\s*" + n + "Y\\D{0,8}(\\d{1,3}\\.\\d{1,2})\\s+(\\d{1,3}\\.\\d{1,2})"));
    if (m) periods[n] = { mu: parseFloat(m[1]), sigma: parseFloat(m[2]) };
  }
  if (pe==null || !Object.keys(periods).length) throw new Error("WPR parse failed");
  return { pe, asOf: dateM ? dateM[1] : null, periods };
}
function scoreFromPeriods(pe, periods){
  const zs = {};
  for (const n of [3,5,10]){ const p=periods[n]; if (p && p.sigma>0) zs[n] = (pe - p.mu)/p.sigma; }
  const vals = Object.values(zs);
  const composite = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  return { zs, composite, score: band(composite) };
}

// monthly = long history (charts + ATH); recent = short daily (price + day move)
function summarise(monthly, recent){
  const rc = recent.points;
  const mc = monthly.points;
  const price = (recent.meta.regularMarketPrice!=null) ? recent.meta.regularMarketPrice
              : (rc.length ? rc[rc.length-1].c : (mc.length ? mc[mc.length-1].c : null));
  let prev = null;
  if (rc.length>=2) prev = rc[rc.length-2].c;
  else if (recent.meta.chartPreviousClose!=null) prev = recent.meta.chartPreviousClose;
  const dayChgPct = (price!=null && prev) ? pct(price, prev) : null;
  const hi = recent.meta.fiftyTwoWeekHigh!=null ? recent.meta.fiftyTwoWeekHigh : (mc.length ? Math.max.apply(null, mc.slice(-13).map(p=>p.c)) : null);
  const lo = recent.meta.fiftyTwoWeekLow !=null ? recent.meta.fiftyTwoWeekLow  : (mc.length ? Math.min.apply(null, mc.slice(-13).map(p=>p.c)) : null);
  const ath = mc.length ? Math.max.apply(null, mc.map(p=>p.c)) : (price!=null ? price : null);
  const fromAthPct = (price!=null && ath) ? pct(price, ath) : null;
  return { price, currency:recent.meta.currency||monthly.meta.currency||"AUD", dayChgPct,
           week52High:hi, week52Low:lo,
           rangePos:(hi!=null&&lo!=null&&hi!==lo)?(price-lo)/(hi-lo)*100:null,
           ath, fromAthPct, history: mc };
}

export default async function handler(req, res){
  res.setHeader("Cache-Control","s-maxage=900, stale-while-revalidate=3600");
  try {
    const extraRaw = (req.query && req.query.extra) ? String(req.query.extra) : "";
    const existing = new Set(ETFS.map(e=>e.ticker.toUpperCase()));
    const customs = extraRaw.split(",").map(s=>s.trim().toUpperCase().replace(/[^A-Z0-9.^-]/g,"")).filter(Boolean)
      .filter((s,i,a)=>a.indexOf(s)===i && !existing.has(s)).slice(0,40)
      .map(t=>({ ticker:t, name:"Added ticker", index:"—", group:"Watchlist", tier:9 }));
    const ALL = ETFS.concat(customs);
    const wq = customs.length ? await fetchQuotes(customs.map(c=>c.ticker)) : {};
    const rows = await Promise.allSettled(ALL.map(async (e) => {
      const [monthly, recent] = await Promise.all([
        fetchChart(e.ticker, "max", "1mo"),
        fetchChart(e.ticker, "5d", "1d"),
      ]);
      const base = Object.assign({}, e, summarise(monthly, recent));

      if (e.tier===1){
        try {
          const wpr = await fetchWPR(e.wpr);
          const sc = scoreFromPeriods(wpr.pe, wpr.periods);
          base.valuation = { basis:"P/E vs own history", pe:wpr.pe, periods:wpr.periods,
            zs:sc.zs, composite:sc.composite, score:sc.score, source:"worldperatio", asOf:wpr.asOf };
        } catch (err){
          base.valuation = { basis:"P/E vs own history", error:String(err.message), score:band(null) };
        }
      } else if (e.tier===9){
        base.name = (recent.meta && (recent.meta.shortName||recent.meta.longName)) || (monthly.meta && (monthly.meta.shortName||monthly.meta.longName)) || e.ticker;
        const q = wq[e.ticker] || wq[e.ticker.toUpperCase()] || {};
        base.valuation = { basis:"Watchlist — current multiples (no history score)", pe:(q.pe!=null?q.pe:null), ps:(q.ps!=null?q.ps:null), score:{ label:"n/a", tone:"na" } };
      } else if (e.tier===2){
        base.valuation = { basis:"Sector/thematic — price only (no reliable free valuation)", score:{ label:"n/a", tone:"na" } };
      } else {
        base.valuation = { basis:"Leveraged (geared) — multiples n/a", score:{ label:"n/a", tone:"na" } };
      }
      return base;
    }));

    const etfs = rows.map((r,i)=> r.status==="fulfilled" ? r.value : Object.assign({}, ALL[i], { error:String((r.reason && r.reason.message) || r.reason) }));
    res.status(200).json({ asOf:Date.now(), etfs });
  } catch (err){
    res.status(500).json({ error:String((err && err.message) || err) });
  }
}
