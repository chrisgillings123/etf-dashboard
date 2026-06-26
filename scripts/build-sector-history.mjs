// Offline refresh job: reconstructs a multi-year BLENDED P/E history for the
// sector/thematic ETFs from their holdings, and writes public/sector-history.json
// (read by /api/data to score them vs their own 3/5/10-yr history).
//
// Why offline: doing ~50 constituents x (price history + EPS history) is far too
// heavy/slow for a per-request serverless call. This runs locally or via the
// GitHub Action (weekly) and commits a tiny JSON the live app reads instantly.
//
// Run:  node scripts/build-sector-history.mjs
//
// Method per ETF: for each top holding, build a monthly P/E series = price / trailing
// EPS (both from Yahoo), blend across holdings by index weight (harmonic mean, the
// correct way to aggregate P/E), then take a 10%-trimmed mean & std over 3/5/10 yrs.

import fs from "node:fs";
import path from "node:path";

const HOLDINGS = {
  SEMI: [["TSM",10.4],["ASML",9.7],["NVDA",9.0],["AVGO",6.5],["AMD",5.0],["QCOM",4.5],["TXN",4.2],["AMAT",4.0],["MU",3.8],["LRCX",3.5],["KLAC",3.3],["ADI",3.2],["NXPI",3.0],["MRVL",2.8],["INTC",2.6]],
  WIRE: [["FCX",9.0],["SCCO",8.0],["BHP",7.0],["IVN.TO",6.0],["TECK",5.5],["ANTO.L",5.0],["FM.TO",4.5],["GLEN.L",4.0],["LUN.TO",3.5],["ERO",3.0],["HBM",2.8],["CS.TO",2.6]],
  BNKS: [["JPM",10.0],["BAC",7.0],["WFC",6.0],["HSBC",5.5],["MS",4.5],["GS",4.5],["C",4.0],["RY",4.0],["MUFG",3.5],["TD",3.2],["SCHW",3.0],["SAN",2.8]],
  FANG: [["AAPL",10],["MSFT",10],["AMZN",10],["META",10],["GOOGL",10],["NFLX",10],["NVDA",10],["AVGO",10],["CRWD",10],["NOW",10]],
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

async function getJson(url){
  for (let a=0;a<3;a++){
    try { const r = await fetch(url,{headers:{ "User-Agent":UA, "Accept":"application/json" }});
      if (r.ok) return r.json();
      if (r.status===429) { await sleep(1500); continue; }
      throw new Error("HTTP "+r.status);
    } catch(e){ if (a===2) throw e; await sleep(800); }
  }
}
const ym = (t)=> { const d=new Date(t); return d.getUTCFullYear()*12 + d.getUTCMonth(); };

async function priceMonthly(sym){
  const j = await getJson("https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(sym)+"?range=15y&interval=1mo");
  const res = j && j.chart && j.chart.result && j.chart.result[0]; if(!res) return [];
  const ts=res.timestamp||[], cl=(res.indicators&&res.indicators.quote&&res.indicators.quote[0]&&res.indicators.quote[0].close)||[];
  const out=[]; for(let i=0;i<ts.length;i++){ if(cl[i]!=null) out.push({t:ts[i]*1000,c:cl[i]}); }
  return out;
}
// quarterly trailing diluted EPS -> [{t, eps}]
async function epsSeries(sym){
  const p2 = Math.floor(Date.now()/1000), p1 = p2 - 16*365*24*3600;
  const url = "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/"+encodeURIComponent(sym)+
    "?symbol="+encodeURIComponent(sym)+"&type=trailingDilutedEPS,quarterlyDilutedEPS&period1="+p1+"&period2="+p2+"&merge=false";
  const j = await getJson(url);
  const arr = (j && j.timeseries && j.timeseries.result) || [];
  const out=[];
  for (const series of arr){
    const key = Object.keys(series).find(k=>k!=="meta"&&k!=="timestamp");
    if (!key || !Array.isArray(series[key])) continue;
    for (const pt of series[key]){
      const v = pt && pt.reportedValue && pt.reportedValue.raw; const d = pt && pt.asOfDate;
      if (v!=null && d) out.push({ t:new Date(d).getTime(), eps:v });
    }
  }
  out.sort((a,b)=>a.t-b.t);
  return out;
}
function epsAt(epsArr, t){ let v=null; for(const e of epsArr){ if(e.t<=t) v=e.eps; else break; } return v; }

async function peSeries(sym){
  const [px, eps] = await Promise.all([priceMonthly(sym), epsSeries(sym)]);
  if (!px.length || !eps.length) return new Map();
  const m = new Map();
  for (const p of px){ const e = epsAt(eps, p.t); if (e!=null && e>0){ m.set(ym(p.t), p.c/e); } }
  return m;
}

function trimmedStats(values){
  const v=[...values].filter(x=>isFinite(x)&&x>0&&x<200).sort((a,b)=>a-b);
  if (v.length<8) return null;
  const k=Math.floor(v.length*0.1); const t=v.slice(k, v.length-k);
  const mu=t.reduce((a,b)=>a+b,0)/t.length;
  const sd=Math.sqrt(t.reduce((a,b)=>a+(b-mu)*(b-mu),0)/t.length);
  return { mu:+mu.toFixed(2), sigma:+(sd||0.01).toFixed(2) };
}

async function buildKey(key){
  const list = HOLDINGS[key];
  const totalW = list.reduce((a,b)=>a+b[1],0);
  const perSym = {};
  for (const pair of list){
    const sym = pair[0];
    try { perSym[sym] = await peSeries(sym); }
    catch(e){ console.warn("  skip",sym,e.message); perSym[sym]=new Map(); }
    await sleep(120);
  }
  const allMonths = new Set();
  for (const s of Object.values(perSym)) for (const k of s.keys()) allMonths.add(k);
  const blended = [];
  for (const mo of [...allMonths].sort((a,b)=>a-b)){
    let wsum=0, ysum=0;
    for (const [sym,w] of list){ const s=perSym[sym]; const pe=s.get(mo);
      if (pe!=null && pe>0){ wsum+=w; ysum+=w/pe; } }
    if (wsum/totalW >= 0.5 && ysum>0) blended.push({ mo, pe: wsum/ysum });
  }
  if (blended.length < 12) return null;
  const nowMo = ym(Date.now());
  const periods={};
  for (const yrs of [3,5,10]){
    const cut = nowMo - yrs*12;
    const vals = blended.filter(b=>b.mo>=cut).map(b=>b.pe);
    const st = trimmedStats(vals);
    if (st) periods[yrs]=st;
  }
  return Object.keys(periods).length ? { asOf:new Date().toISOString().slice(0,10), periods, coveragePoints:blended.length } : null;
}

async function main(){
  const out = {};
  for (const key of Object.keys(HOLDINGS)){
    process.stdout.write("Building "+key+" ... ");
    try { const r = await buildKey(key); out[key]=r; console.log(r?"ok ("+JSON.stringify(r.periods)+")":"insufficient data"); }
    catch(e){ console.log("error",e.message); out[key]=null; }
  }
  const dir = path.join(process.cwd(),"public"); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"sector-history.json"), JSON.stringify(out,null,2));
  console.log("\nWrote public/sector-history.json");
}
main();
