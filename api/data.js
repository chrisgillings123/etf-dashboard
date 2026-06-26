// Vercel serverless function — ETF valuation dashboard data API.
//
// Valuation is MULTIPLES-BASED + MEAN-REVERTING:
//   score = how far today's P/E sits from the index's OWN trailing 3/5/10-yr
//           average P/E, measured in standard deviations (z).
//   z < 0  => trading below its historical multiple  => cheap / undervalued
//   z > 0  => trading above its historical multiple  => rich  / overvalued
//
// Tier 1 (broad/regional): current P/E + 3/5/10/20-yr mean & sigma pulled live
//   from worldperatio.com (which derives them from the index's proxy ETF).
// Tier 2 (sector/thematic): blended P/E & P/Rev reconstructed live from holdings;
//   their 3/5/10-yr P/E history comes from public/sector-history.json, produced
//   offline by scripts/build-sector-history.mjs (see README).
//
// Prices, day change, 52-wk range, all-time-high drawdown and charts come from Yahoo.

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- ETF universe
const ETFS = [
  // Tier 1 — worldperatio
  { ticker:"IHVV.AX", name:"iShares S&P 500 (AUD Hedged)",                   index:"S&P 500",                            group:"Broad / Developed", tier:1, wpr:"https://worldperatio.com/index/sp-500",          proxy:"SPY" },
  { ticker:"HNDQ.AX", name:"Betashares Nasdaq 100 (Hedged)",                 index:"Nasdaq-100",                         group:"Broad / Developed", tier:1, wpr:"https://worldperatio.com/index/nasdaq-100",      proxy:"QQQ" },
  { ticker:"VGAD.AX", name:"Vanguard MSCI Intl Shares (Hedged)",             index:"MSCI World ex-Australia",            group:"Broad / Developed", tier:1, wpr:"https://worldperatio.com/area/msci-world",       proxy:"URTH" },
  { ticker:"WXHG.AX", name:"SPDR S&P World ex-Aus Carbon Aware (Hedged)",    index:"S&P Developed ex-Aus (~MSCI World)", group:"ESG / Climate",     tier:1, wpr:"https://worldperatio.com/area/msci-world",       proxy:"URTH" },
  { ticker:"IHWL.AX", name:"iShares MSCI World ex-Aus ESG Leaders (Hedged)", index:"MSCI World ESG (~MSCI World)",       group:"ESG / Climate",     tier:1, wpr:"https://worldperatio.com/area/msci-world",       proxy:"URTH" },
  { ticker:"IEM.AX",  name:"iShares MSCI Emerging Markets",                  index:"MSCI Emerging Markets",              group:"Regional / EM",     tier:1, wpr:"https://worldperatio.com/area/emerging-markets", proxy:"EEM" },
  { ticker:"VAE.AX",  name:"Vanguard FTSE Asia ex Japan",                    index:"FTSE Asia Pac ex Japan",             group:"Regional / EM",     tier:1, wpr:"https://worldperatio.com/area/asia-ex-japan",   proxy:"AAXJ" },
  // Tier 2 — holdings reconstruction
  { ticker:"SEMI.AX", name:"Global X Semiconductor",          index:"Solactive Global Semiconductor 30", group:"Thematic / Sector", tier:2, key:"SEMI" },
  { ticker:"WIRE.AX", name:"Global X Copper Miners",          index:"Solactive Global Copper Miners",    group:"Thematic / Sector", tier:2, key:"WIRE" },
  { ticker:"BNKS.AX", name:"Betashares Global Banks (Hedged)", index:"Nasdaq Global ex-Aus Banks",       group:"Thematic / Sector", tier:2, key:"BNKS" },
  { ticker:"FANG.AX", name:"Global X FANG+",                  index:"NYSE FANG+",                         group:"Thematic / Sector", tier:2, key:"FANG" },
  { ticker:"FHNG.AX", name:"Global X FANG+ (Hedged)",         index:"NYSE FANG+",                         group:"Thematic / Sector", tier:2, key:"FANG" },
  // Leveraged / geared — price only, valuation n/a (gearing distorts multiples)
  { ticker:"GGBL.AX", name:"Betashares Geared Global Equity (Hedged)", index:"Geared global equities (~2x)", group:"Leveraged", tier:0 },
  { ticker:"GNDQ.AX", name:"Betashares Geared Nasdaq 100 (Hedged)",    index:"Geared Nasdaq-100 (~2x)",      group:"Leveraged", tier:0 },
];

// Top constituents (symbol + approx index weight %). Concentrated funds, so the
// top names dominate; weights are renormalised over whatever data Yahoo returns.
// asOf is stamped so staleness is visible. Refresh from issuer holdings pages.
const HOLDINGS = {
  asOf: "2026-06",
  FANG: { equalWeight:true, names:["AAPL","MSFT","AMZN","META","GOOGL","NFLX","NVDA","AVGO","CRWD","NOW"] },
  SEMI: [["TSM",10.4],["ASML",9.7],["NVDA",9.0],["AVGO",6.5],["AMD",5.0],["QCOM",4.5],["TXN",4.2],["AMAT",4.0],["MU",3.8],["LRCX",3.5],["KLAC",3.3],["ADI",3.2],["NXPI",3.0],["MRVL",2.8],["INTC",2.6]],
  WIRE: [["FCX",9.0],["SCCO",8.0],["BHP",7.0],["IVN.TO",6.0],["TECK",5.5],["ANTO.L",5.0],["FM.TO",4.5],["GLEN.L",4.0],["LUN.TO",3.5],["ERO",3.0],["HBM",2.8],["CS.TO",2.6]],
  BNKS: [["JPM",10.0],["BAC",7.0],["WFC",6.0],["HSBC",5.5],["MS",4.5],["GS",4.5],["C",4.0],["RY",4.0],["MUFG",3.5],["TD",3.2],["SCHW",3.0],["SAN",2.8]],
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function getJson(url) {
  const r = await fetch(url, { headers:{ "User-Agent":UA, "Accept":"application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers:{ "User-Agent":UA, "Accept":"text/html" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

// ---------------------------------------------------------------- Yahoo prices
async function fetchChart(symbol, range="max", interval="1d") {
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
// batch quote -> { SYM: {pe, ps, price} }
async function fetchQuotes(symbols) {
  const out = {};
  if (!symbols.length) return out;
  try {
    const j = await getJson("https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + symbols.map(encodeURIComponent).join(","));
    const list = (j && j.quoteResponse && j.quoteResponse.result) || [];
    for (const q of list) {
      out[q.symbol] = {
        pe: isFinite(q.trailingPE) ? q.trailingPE : null,
        ps: isFinite(q.priceToSalesTrailing12Months) ? q.priceToSalesTrailing12Months : (isFinite(q.priceToSales) ? q.priceToSales : null),
        price: q.regularMarketPrice != null ? q.regularMarketPrice : null,
      };
    }
  } catch (e) { /* leave out empty */ }
  return out;
}

// ---------------------------------------------------------------- valuation math
function pct(a,b){ return b ? (a-b)/b*100 : null; }

function band(z){
  if (z==null) return { label:"n/a", tone:"na" };
  if (z<=-2) return { label:"Cheap",        tone:"cheap" };
  if (z<=-1) return { label:"Undervalued",  tone:"under" };
  if (z<  1) return { label:"Fair value",   tone:"fair" };
  if (z<  2) return { label:"Overvalued",   tone:"over" };
  return        { label:"Expensive",    tone:"exp" };
}
// blended (cap-weighted) index multiple from constituent multiples = harmonic mean
function blend(weights, mults){
  let wsum=0, ysum=0;
  for (let i=0;i<mults.length;i++){ const m=mults[i], w=weights[i]; if (m!=null && m>0){ wsum+=w; ysum+=w/m; } }
  if (wsum===0 || ysum===0) return { value:null, coverage:0 };
  return { value: wsum/ysum, coverage: wsum };
}

// ---------------------------------------------------------------- worldperatio
function stripHtml(html){
  return html.replace(/<script[\s\S]*?<\/script>/gi," ")
             .replace(/<style[\s\S]*?<\/style>/gi," ")
             .replace(/<[^>]+>/g," ")
             .replace(/&[a-z]+;/gi," ")
             .replace(/\s+/g," ");
}
// returns { pe, asOf, periods:{3:{mu,sigma},5:..,10:..} }
async function fetchWPR(url){
  const txt = stripHtml(await getText(url));
  let pe = null;
  const peM = txt.match(/P\/E Ratio[^\d]{0,12}(\d{1,3}\.\d{1,2})/);
  if (peM) pe = parseFloat(peM[1]);
  const dateM = txt.match(/(\d{1,2}\s+\w+\s+20\d\d)/);
  const periods = {};
  for (const n of [3,5,10]) {
    const m = txt.match(new RegExp("Last\\s*" + n + "Y\\D{0,8}(\\d{1,3}\\.\\d{1,2})\\s+(\\d{1,3}\\.\\d{1,2})"));
    if (m) periods[n] = { mu: parseFloat(m[1]), sigma: parseFloat(m[2]) };
  }
  if (pe==null || !Object.keys(periods).length) throw new Error("WPR parse failed");
  return { pe, asOf: dateM ? dateM[1] : null, periods };
}

function scoreFromPeriods(pe, periods){
  const zs = {};
  for (const n of [3,5,10]) {
    const p = periods[n];
    if (p && p.sigma>0) zs[n] = (pe - p.mu)/p.sigma;
  }
  const vals = Object.values(zs);
  const composite = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  return { zs, composite, score: band(composite) };
}

// ---------------------------------------------------------------- price summary
function summarise(meta, points){
  const last = points[points.length-1];
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : (last ? last.c : null);
  // Day move uses the true prior-day close (meta.previousClose = yesterday).
  // Do not use meta.chartPreviousClose: over a long range it is the close
  // before the window start, which caused the huge percentage bug.
  let prev = (meta.previousClose!=null && isFinite(meta.previousClose)) ? meta.previousClose : null;
  if (prev==null && points.length>=2) prev = points[points.length-2].c;
  const dayChgPct = (price!=null && prev) ? pct(price, prev) : null;
  const hi = meta.fiftyTwoWeekHigh != null ? meta.fiftyTwoWeekHigh : Math.max.apply(null, points.slice(-252).map(p=>p.c));
  const lo = meta.fiftyTwoWeekLow  != null ? meta.fiftyTwoWeekLow  : Math.min.apply(null, points.slice(-252).map(p=>p.c));
  // All-time high from full available history + % below it (<=0).
  const ath = points.length ? Math.max.apply(null, points.map(p=>p.c)) : null;
  const fromAthPct = (price!=null && ath) ? pct(price, ath) : null;
  return { price, currency:meta.currency||"AUD", dayChgPct, week52High:hi, week52Low:lo,
           rangePos:(hi!=null&&lo!=null&&hi!==lo)?(price-lo)/(hi-lo)*100:null,
           ath, fromAthPct };
}
function downsample(points, every=5){
  const out=[]; for(let i=0;i<points.length;i+=every) out.push(points[i]);
  if(points.length&&out[out.length-1]!==points[points.length-1]) out.push(points[points.length-1]);
  return out;
}

// sector history (offline-built); optional
function loadSectorHistory(){
  try {
    const p = path.join(process.cwd(), "public", "sector-history.json");
    return JSON.parse(fs.readFileSync(p,"utf8"));
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- handler
export default async function handler(req, res){
  res.setHeader("Cache-Control","s-maxage=900, stale-while-revalidate=3600");
  try {
    const sectorHist = loadSectorHistory();

    // gather every constituent symbol once for a single batched quote call
    const consSet = new Set();
    for (const e of ETFS) {
      if (e.tier===2){
        const h = HOLDINGS[e.key];
        const names = h.equalWeight ? h.names : h.map(x=>x[0]);
        names.forEach(s=>consSet.add(s));
      }
    }
    const quotes = await fetchQuotes(Array.from(consSet));

    const rows = await Promise.allSettled(ETFS.map(async (e) => {
      const chart = await fetchChart(e.ticker);
      const base = Object.assign({}, e, summarise(chart.meta, chart.points), { history: downsample(chart.points,5) });

      if (e.tier===0){
        base.valuation = { basis:"Leveraged (geared) — multiples n/a", score:{ label:"n/a", tone:"na" } };
        return base;
      }

      if (e.tier===1){
        try {
          const wpr = await fetchWPR(e.wpr);
          const sc = scoreFromPeriods(wpr.pe, wpr.periods);
          base.valuation = { basis:"P/E vs own history", pe:wpr.pe, ps:null,
            periods:wpr.periods, zs:sc.zs, composite:sc.composite, score:sc.score,
            source:"worldperatio", asOf:wpr.asOf };
        } catch (err){
          base.valuation = { basis:"P/E vs own history", error:String(err.message), score:band(null) };
        }
        return base;
      }

      // tier 2 — blended multiple from holdings
      const h = HOLDINGS[e.key];
      const list = h.equalWeight ? h.names.map(s=>[s,100/h.names.length]) : h;
      const w = list.map(x=>x[1]);
      const peArr = list.map(x=> (quotes[x[0]] && quotes[x[0]].pe!=null) ? quotes[x[0]].pe : null);
      const psArr = list.map(x=> (quotes[x[0]] && quotes[x[0]].ps!=null) ? quotes[x[0]].ps : null);
      const bpe = blend(w, peArr), bps = blend(w, psArr);
      const totalW = w.reduce((a,b)=>a+b,0);
      const v = { basis:"Blended P/E from holdings", pe:bpe.value, ps:bps.value,
        coverage: Math.round(bpe.coverage/totalW*100), holdingsAsOf:HOLDINGS.asOf, source:"holdings" };
      const hist = sectorHist ? sectorHist[e.key] : null;
      if (hist && hist.periods && bpe.value!=null){
        const sc = scoreFromPeriods(bpe.value, hist.periods);
        Object.assign(v, { periods:hist.periods, zs:sc.zs, composite:sc.composite, score:sc.score, histAsOf:hist.asOf });
      } else {
        v.score = { label:"history pending", tone:"na" };
        v.note = "Current multiple shown; multi-year history not yet built (run the refresh script).";
      }
      base.valuation = v;
      return base;
    }));

    const etfs = rows.map((r,i)=> r.status==="fulfilled" ? r.value : Object.assign({}, ETFS[i], { error:String((r.reason && r.reason.message) || r.reason) }));
    res.status(200).json({ asOf:Date.now(), etfs });
  } catch (err){
    res.status(500).json({ error:String((err && err.message) || err) });
  }
}
