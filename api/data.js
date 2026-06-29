// Vercel serverless function — ETF valuation dashboard data API.
//
// Valuation (mean-reverting, multiples-based) applies to the broad/regional ETFs:
//   score = how far today's index P/E sits from its OWN trailing 3/5/10-yr average
//           P/E, in standard deviations (z). z<0 cheap vs history, z>0 rich.
//   Source: worldperatio.com (P/E + 3/5/10/20-yr mean & sigma per index).
// Sector/thematic ETFs: price-only (free data can't value these baskets reliably).
// Leveraged ETFs: price-only (gearing distorts multiples).
//
// Prices, day move, 52-wk range, all-time-high drawdown and charts: Yahoo Finance.
//   - long monthly series (range=max&interval=1mo) -> charts + all-time high
//   - short daily series  (range=5d&interval=1d)   -> accurate latest price + day move

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

// Single-stock trailing EPS via the fundamentals-timeseries endpoint (usually
// reachable from cloud servers, unlike the quote API). P/E is then price / EPS.
async function fetchEps(symbol){
  try {
    const p2 = Math.floor(Date.now()/1000), p1 = p2 - 3*365*24*3600;
    const url = "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/" + encodeURIComponent(symbol) +
      "?symbol=" + encodeURIComponent(symbol) + "&type=trailingDilutedEPS,annualDilutedEPS&period1=" + p1 + "&period2=" + p2 + "&merge=false";
    const j = await getJson(url);
    const arr = (j && j.timeseries && j.timeseries.result) || [];
    const pick = (name)=>{ let best=null; for (const sObj of arr){ if (!Array.isArray(sObj[name])) continue;
      for (const pt of sObj[name]){ const v=pt && pt.reportedValue && pt.reportedValue.raw; const d=pt && pt.asOfDate;
        if (v!=null && d){ const t=new Date(d).getTime(); if (!best || t>best.t) best={t,v}; } } } return best?best.v:null; };
    const eps = pick("trailingDilutedEPS");
    return eps!=null ? eps : pick("annualDilutedEPS");
  } catch (e) { return null; }
}

// Finnhub basic financials (needs free FINNHUB_API_KEY). Returns current P/E and a
// historical valuation series so US watchlist stocks can be scored vs their own history.
async function fetchFinnhubMetric(symbol){
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  try { return await getJson("https://finnhub.io/api/v1/stock/metric?symbol=" + encodeURIComponent(symbol) + "&metric=all&token=" + encodeURIComponent(key)); }
  catch (e) { return null; }
}
function finnhubPE(data){
  const m = (data && data.metric) || {};
  const pe = (m.peTTM!=null) ? m.peTTM : (m.peBasicExclExtraTTM!=null ? m.peBasicExclExtraTTM : (m.peNormalizedAnnual!=null ? m.peNormalizedAnnual : null));
  return (pe!=null && isFinite(pe)) ? pe : null;
}
function rollingTTM(pts){
  if (pts.length<2) return pts.map(p=>({t:p.t,eps:p.v}));
  const gaps=[]; for (let i=1;i<pts.length;i++) gaps.push(pts[i].t-pts[i-1].t);
  gaps.sort((a,b)=>a-b); const med=gaps[Math.floor(gaps.length/2)];
  if (med > 200*864e5) return pts.map(p=>({t:p.t,eps:p.v}));        // annual-ish: already TTM
  const out=[]; for (let i=3;i<pts.length;i++) out.push({ t:pts[i].t, eps:pts[i].v+pts[i-1].v+pts[i-2].v+pts[i-3].v });
  return out;                                                       // quarterly: rolling 4
}
// {3,5,10}:{mu,sigma} from a US stock's own P/E history (Finnhub series + Yahoo price)
function buildStockPeriods(data, monthlyPoints){
  const series = data && data.series; if (!series) return null;
  const ann = series.annual || {}, qtr = series.quarterly || {};
  let seq = [];
  const directPE = (Array.isArray(ann.pe) && ann.pe) || (Array.isArray(qtr.pe) && qtr.pe) || null;
  if (directPE){
    seq = directPE.map(x=>({ t:new Date(x.period).getTime(), pe:x.v })).filter(x=>isFinite(x.pe)&&x.pe>0);
  } else if (monthlyPoints && monthlyPoints.length){
    const epsRaw = (Array.isArray(qtr.eps)&&qtr.eps) || (Array.isArray(qtr.epsBasicExclExtraItems)&&qtr.epsBasicExclExtraItems)
                || (Array.isArray(ann.eps)&&ann.eps) || (Array.isArray(ann.epsBasicExclExtraItems)&&ann.epsBasicExclExtraItems) || null;
    if (epsRaw){
      const pts = epsRaw.map(x=>({ t:new Date(x.period).getTime(), v:x.v })).filter(x=>isFinite(x.v)).sort((a,b)=>a.t-b.t);
      const ttm = rollingTTM(pts);
      const priceAt=(t)=>{ let v=null; for (const p of monthlyPoints){ if (p.t<=t) v=p.c; else break; } return v; };
      seq = ttm.map(e=>{ const pr=priceAt(e.t); return (pr&&e.eps>0)?{ t:e.t, pe:pr/e.eps }:null; }).filter(Boolean);
    }
  }
  if (seq.length<3) return null;
  const now=Date.now(), out={};
  for (const yrs of [3,5,10]){
    const cut=now-yrs*365.25*864e5;
    const vals=seq.filter(x=>x.t>=cut).map(x=>x.pe).filter(v=>v>0&&v<200);
    if (vals.length>=2){ const mu=vals.reduce((a,b)=>a+b,0)/vals.length;
      const sd=Math.sqrt(vals.reduce((a,b)=>a+(b-mu)*(b-mu),0)/vals.length);
      out[yrs]={ mu:+mu.toFixed(1), sigma:+(sd||0.1).toFixed(2) }; }
  }
  return Object.keys(out).length ? out : null;
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
        const fdata = await fetchFinnhubMetric(e.ticker);
        let pe = finnhubPE(fdata);
        if (pe==null) { try { const eps = await fetchEps(e.ticker); if (eps!=null && eps>0 && base.price!=null) pe = base.price/eps; } catch (e2) {} }
        const v = { basis:"Watchlist — P/E vs own history", pe:pe, score:{ label:"n/a", tone:"na" } };
        const periods = buildStockPeriods(fdata, monthly.points);
        if (periods && pe!=null){ const sc = scoreFromPeriods(pe, periods); Object.assign(v, { periods:periods, zs:sc.zs, composite:sc.composite, score:sc.score }); }
        v.seriesKeys = (fdata && fdata.series && fdata.series.annual) ? Object.keys(fdata.series.annual) : (fdata && fdata.series ? Object.keys(fdata.series) : "no-series");
        base.valuation = v;
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
