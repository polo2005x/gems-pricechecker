'use strict';
/* PoE1 Profit Checker
 * Data: poe.ninja economy (SkillGem + Currency + Scarab overviews).
 * All money math is done in CHAOS, then converted for display.
 * Two top-level views (MODE): 'gems' (leveling/corruption profit) and
 * 'scarabs' (mechanic-grouped scarab values with rarity weighting). */

// ---------- persistent state ----------
const LS = {
  data: 'gpc_data',
  settings: 'gpc_settings',
  overrides: 'gpc_overrides',
};
let GEMS = [];            // computed gem rows (all)
let CURR = {};            // { gcp, vaal, div }  (chaos values, from currency data if present)
let OVER = load(LS.overrides, {});   // { "<detailsId>::<field>": number }
let CAT = 'top';
const GAME = 'poe1';                  // this tool is PoE1-only
let LEAGUE_SLUG = {};                 // league name -> poe.ninja slug (for per-league data files)
let MODE = load('gpc_mode', 'gems');  // 'gems' | 'scarabs' — top-level view
let SCARABS = null;                   // { divineRate, rows:[{id,name,image,chaos,volume}] } for current league

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
function load(k, def){ try{ return JSON.parse(localStorage.getItem(k)) ?? def; }catch{ return def; } }
function save(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){ /* quota */ } }
const num = (v) => (v===''||v==null||isNaN(+v)) ? null : +v;

// ---------- assumptions ----------
const ASSUME_IDS = ['divRate','gcpCost','vaalCost','gcpForQ','evBase','pVaal','pDouble','dblCost','failModel'];
function readAssume(){
  return {
    divRate: +$('divRate').value || 1,
    gcpCost: +$('gcpCost').value || 0,
    vaalCost:+$('vaalCost').value || 0,
    gcpForQ: +$('gcpForQ').value || 0,
    evBase:  $('evBase').value,          // 'buyin' | 'leveled'
    pV: (+$('pVaal').value||0)/100,
    pD: (+$('pDouble').value||0)/100,
    dblCost: +$('dblCost').value || 0,
    failModel: $('failModel').value,
    metaQuality: +$('metaQuality').value || 20,        // Empower-tier leveling-quality bracket
    metaQualityCost: $('metaQualityCost').checked,     // charge 20 GCP for that quality
    levelQ20: $('levelQ20').checked,                   // level to 20% quality (quality tabs)
  };
}
function saveSettings(){
  const s={}; ASSUME_IDS.forEach(id => s[id]=$(id).value);
  ['league','unit','sort','minList','search','confFilter','autoRefresh','autoMin','metaQuality','metaQualityCost','levelQ20'].forEach(id=>{
    const el=$(id); if(!el) return; s[id] = el.type==='checkbox'?el.checked:el.value;
  });
  save(LS.settings, s);
}
function restoreSettings(){
  const s=load(LS.settings,null); if(!s) return;
  Object.entries(s).forEach(([id,val])=>{
    const el=$(id); if(!el) return;
    if(el.type==='checkbox') el.checked=val; else el.value=val;
  });
}

// ---------- variant parsing ----------
// "1" -> {lvl:1,q:0,c:false} ; "20/20" -> {20,20,false} ; "21/20c" -> {21,20,true}
function parseVariant(v){
  if(typeof v!=='string' || !v) return null;
  let c=false;
  if(v.endsWith('c')){ c=true; v=v.slice(0,-1); }
  const parts=v.split('/');
  const lvl=parseInt(parts[0],10);
  if(isNaN(lvl)) return null;
  const q = parts.length>1 ? (parseInt(parts[1],10)||0) : 0;
  return {lvl,q,c};
}
// ---------- gem categories ----------
// meta  = Empower / Enlighten / Enhance (incl. Awakened) + Eclipse — leveled for the level bonus, quality irrelevant
// exceptional = drop-only "exceptional" support gems (poewiki.net/wiki/Exceptional) — they cap at level 3
// normal = everything else
const META_RE = /(Empower|Enlighten|Enhance) Support$/;   // matches Awakened variants too
// Detected from data (a Support gem that caps at level 3) so it self-maintains as GGG adds gems,
// rather than a hardcoded list that goes stale (missed Communion / Coursing Current / Crystalfall).
function categoryOf(name, maxLvl){
  if(name === 'Eclipse Support' || META_RE.test(name)) return 'meta';
  if(/ Support$/.test(name) && maxLvl!=null && maxLvl<=3) return 'exceptional';
  // transfigured skill gems carry a trade discriminator (alt_x/y/z) — incl. the "of Trarthus" (Trarthan) set
  if(TRADEMAP[name] && TRADEMAP[name].d) return 'transfigured';
  return 'normal';
}

// Rough XP-to-max, from poedb tables (2026-08). Exceptional + Empower-tier share one curve
// (~1.67B to level 3); Awakened supports ~2B to level 5; a normal level-20 gem ~240M.
const NORMAL_XP = 2.4e8;  // baseline: a normal gem to level 20
function xpEstimate(cat, name){
  if(cat==='meta' || cat==='exceptional') return 1.666e9;  // to level 3
  if(/^Awakened /.test(name))             return 2.1e9;    // to level 5
  return NORMAL_XP;  // ~all normal skill/support gems cap at 20; data max-level is unreliable for thin markets
}
function xpTierFor(est){
  return est < 1.8e8 ? 'Fast' : est < 4.5e8 ? 'Normal' : est < 1.0e9 ? 'Hard' : 'Brutal';
}

// ---------- build gem rows from raw lines ----------
function buildGems(lines){
  const groups={};
  for(const l of lines){
    const pv=parseVariant(l.variant); if(!pv) continue;
    const key=l.name;
    (groups[key] = groups[key] || {name:l.name, icon:l.icon, map:{}, maxList:0});
    const g=groups[key];
    g.map[`${pv.lvl}/${pv.q}/${pv.c?1:0}`] = { chaos:l.chaosValue, list:l.listingCount||0, pv };
    if(!g.icon && l.icon) g.icon=l.icon;
    g.maxList=Math.max(g.maxList, l.listingCount||0);
  }
  // map each gem to its Vaal counterpart's prices (e.g. Blade Vortex -> Vaal Blade Vortex).
  // Vaal gems are named "Vaal X" or, for transfigured, "Vaal X (Transfigured Name)".
  const vaalMap={};
  for(const gg of Object.values(groups)){
    if(!/^Vaal /.test(gg.name)) continue;
    const mm=gg.name.match(/^Vaal .+ \((.+)\)$/);
    vaalMap[mm ? mm[1] : gg.name.replace(/^Vaal /,'')] = gg.map;
  }
  const out=[];
  for(const g of Object.values(groups)){
    const rows=Object.values(g.map);
    const unc=rows.filter(r=>!r.pv.c);
    if(!unc.length) continue;                    // pure-corrupted (Vaal gems) — can't self-level, skip
    const baseLvl=Math.min(...unc.map(r=>r.pv.lvl));
    const maxLvl =Math.max(...unc.map(r=>r.pv.lvl));
    if(maxLvl<=baseLvl) continue;                // nothing to level
    const at=(lvl,q,c)=>{ const r=g.map[`${lvl}/${q}/${c?1:0}`]; return r?r.chaos:null; };
    const atL=(lvl,q,c)=>{ const r=g.map[`${lvl}/${q}/${c?1:0}`]; return r?r.list:null; };
    const buyL = at(baseLvl,0,false)!=null ? atL(baseLvl,0,false) : atL(baseLvl,20,false);  // match raw.buy's tier
    // pick the highest uncorrupted quality available at maxLvl (usually 20; awakened exc. may be 0/20)
    const qsAtMax = unc.filter(r=>r.pv.lvl===maxLvl).map(r=>r.pv.q);
    const topQ = Math.max(0,...qsAtMax);         // 20 for normal gems, 0 for exceptional
    const cat=categoryOf(g.name, maxLvl);
    const vm=vaalMap[g.name];                                   // this gem's Vaal counterpart, if any
    const vaalCell=vm ? vm[`${maxLvl+1}/20/1`] : null;          // Vaal version at +1 level / 20q, corrupted
    out.push({
      id:l_id(g.name), name:g.name, icon:g.icon,
      baseLvl, maxLvl, topQ, maxList:g.maxList,
      cat, xpEst:xpEstimate(cat, g.name),
      vaalPrize: vaalCell ? vaalCell.chaos : null,
      vaalPrizeList: vaalCell ? vaalCell.list : null,
      // Prices at both quality tiers (0 and 20). Some gems only trade at one tier
      // (e.g. Empower = 0q only; Eclipse / Greater supports = 20q only) — computeMetrics
      // picks whichever exists so nothing shows blank spuriously.
      raw:{
        buy: at(baseLvl,0,false) ?? at(baseLvl,20,false),  // L1, prefer 0q
        L0:  at(maxLvl,0,false),      // leveled, 0 quality
        L20: at(maxLvl,20,false),     // leveled, 20 quality
        P0:  at(maxLvl+1,0,true),     // corrupted +1 level, 0 quality (the "prize")
        P20: at(maxLvl+1,20,true),    // corrupted +1 level, 20 quality
        P23: at(maxLvl+1,23,true),    // corrupted +1 level, 23 quality (double-corrupt jackpot)
        F0:  at(maxLvl,0,true),       // corrupted same level, 0q (fail/brick resale)
        F20: at(maxLvl,20,true),      // corrupted same level, 20q
      },
      // poe.ninja listing count backing each price → confidence indicator
      rawList:{
        buy: buyL,
        L0:  atL(maxLvl,0,false),   L20: atL(maxLvl,20,false),
        P0:  atL(maxLvl+1,0,true),  P20: atL(maxLvl+1,20,true), P23: atL(maxLvl+1,23,true),
      },
    });
  }
  return out;
}
function l_id(name){ return name.toLowerCase().replace(/[^a-z0-9]+/g,'-'); }

// ---------- currency ----------
function buildCurrency(lines){
  const find=(n)=>{ const x=lines.find(l=>l.currencyTypeName===n); return x?x.chaosEquivalent:null; };
  return {
    gcp: find("Gemcutter's Prism"),
    vaal: find('Vaal Orb'),
    div: find('Divine Orb'),
  };
}

// ---------- per-gem profit metrics ----------
function val(g, field){ // override wins if present
  const o=OVER[`${g.id}::${field}`];
  return (o!=null) ? o : g.raw[field];
}
// mode: 'meta' (quality-agnostic — use whichever tier the gem trades at, no GCP)
//       'quality' (normal/exceptional — the 20%-quality flip, GCP included)
function computeMetrics(g, a, mode){
  const buy=val(g,'buy'), L0=val(g,'L0'), L20=val(g,'L20'),
        P0=val(g,'P0'), P20=val(g,'P20'), F0=g.raw.F0, F20=g.raw.F20;
  const gq = a.gcpForQ * a.gcpCost;
  const m = { buy, buyField:'buy' };

  let leveled, leveledField, prize, prizeField, failRaw, base;
  if(mode==='meta'){
    // quality doesn't change the corrupt outcome for this tier — take whichever tier has data.
    // Optionally charge the 20-GCP cost of quality-ing the gem to speed up leveling.
    const qCost = a.metaQualityCost ? gq : 0;
    leveled = L0 ?? L20; leveledField = L0!=null ? 'L0':'L20';
    prize   = P0 ?? P20; prizeField   = P0!=null ? 'P0':'P20';
    failRaw = F0 ?? F20;
    const rawBase = (a.evBase==='leveled') ? (L0 ?? L20) : buy;
    base = rawBase==null ? null : rawBase + qCost;
    m.levelProfit = (leveled!=null && buy!=null) ? leveled - buy - qCost : null;
  } else {
    // 20%-quality flip.
    prize   = P20 ?? P0; prizeField   = P20!=null ? 'P20':'P0';
    failRaw = F20 ?? F0;
    base = (a.evBase==='leveled')
      ? (L20 ?? (L0!=null ? L0+gq : null))    // buy a leveled 20q gem (or a 0q one + GCP)
      : (buy!=null ? buy+gq : null);          // buy L1 + GCP to 20q
    if(a.levelQ20){
      // ON: max level / 20% quality (20/20, or 3/20 for exceptional). Charge GCP in the profit.
      leveled = L20; leveledField = 'L20';
      m.levelProfit = (L20!=null && buy!=null) ? L20 - buy - gq : null;
    } else {
      // OFF: max level / 0% quality (20/0, or 3/0). Pure level-only flip, no GCP.
      leveled = L0; leveledField = 'L0';
      m.levelProfit = (L0!=null && buy!=null) ? L0 - buy : null;
    }
    // sanity cap: a max-level UNcorrupted gem can't rationally beat the corrupted +1-level prize
    // (you could just Vaal it for a shot at the pricier +1). Guards against poe.ninja outliers
    // like a 2-listing 20/20 mispriced at 15,957c inflating the leveling profit.
    if(prize!=null && leveled!=null && leveled>prize){
      leveled = prize;
      m.levelProfit = (buy!=null) ? leveled - buy - (a.levelQ20?gq:0) : null;
    }
  }
  m.leveled=leveled; m.leveledField=leveledField;
  m.prize=prize; m.prizeField=prizeField;
  m.p23 = val(g,'P23'); m.p23Field='P23';   // double-corrupt jackpot (+1 level / 23q)
  m.vaalPrize = g.vaalPrize ?? null;         // Vaal-counterpart gem at +1 level / 20q (display only)
  // listing counts (confidence) for the displayed price cells
  const RL = g.rawList || {};
  m.buyList = RL.buy;
  m.leveledList = RL[leveledField];
  m.prizeList = RL[prizeField];
  m.p23List = RL.P23;
  // gem confidence = weakest of the key priced variants (buy / leveled / prize)
  const cc = [m.buyList, m.leveledList, m.prizeList].filter(v=>v!=null);
  m.confCount = cc.length ? Math.min(...cc) : null;
  m.confTier  = m.confCount==null ? 'none' : m.confCount>10 ? 'high' : m.confCount>3 ? 'med' : 'low';

  const failVal=(proxy, basis)=>{
    if(a.failModel==='zero') return 0;
    if(a.failModel==='buy')  return basis==null ? 0 : basis;
    return proxy!=null ? proxy : 0;               // corrupted same-level price (default)
  };
  m.fail = failVal(failRaw, base);
  // sanity cap: a failed corrupt (same level) can't rationally be worth more than the +1-level prize.
  // Guards against poe.ninja outliers (e.g. a 2-listing 20/20c mispriced 1000x) inflating the EV.
  if(prize!=null && m.fail>prize) m.fail = prize;

  // expected NET investment to produce ONE +1 gem (accounts for reselling the bricks):
  //   ~1/p attempts, each costs base+orb; you recover FailValue on the (1/p − 1) misses.
  const invest=(pr, bs, fl, orb, p)=>{
    if(pr==null || bs==null || p<=0) return null;
    const n=1/p; return n*(bs+orb) - (n-1)*fl;
  };
  if(prize!=null && base!=null){
    m.winVaal = prize - base - a.vaalCost;
    m.evVaal  = a.pV*prize + (1-a.pV)*m.fail - base - a.vaalCost;
    m.invVaal = invest(prize, base, m.fail, a.vaalCost, a.pV);
    m.winDbl  = prize - base - a.dblCost;
    m.evDbl   = a.pD*prize + (1-a.pD)*m.fail - base - a.dblCost;
    m.invDbl  = invest(prize, base, m.fail, a.dblCost, a.pD);
  }

  // time-adjusted leveling profit: Level profit ÷ grind multiple (XP-to-max vs a normal gem).
  // Empower-tier uses the quality-boosted XP; a gem taking 7× as long has its profit divided by 7.
  let estXP = g.xpEst;
  if(mode==='meta') estXP = g.xpEst / (1 + 0.05*a.metaQuality);
  m.grind = estXP / NORMAL_XP;
  m.adjProfit = (m.levelProfit!=null && m.grind>0) ? m.levelProfit / m.grind : null;
  // corruption EV per unit of leveling time (self-level framing): EV/attempt ÷ grind
  m.adjVaal = (m.evVaal!=null && m.grind>0) ? m.evVaal / m.grind : null;
  m.adjDbl  = (m.evDbl!=null  && m.grind>0) ? m.evDbl  / m.grind : null;
  return m;
}

// ---------- formatting ----------
function unitDiv(){ return $('unit').value==='div'; }
function fmt(chaos){
  if(chaos==null) return '<span class="dim">–</span>';
  const div=unitDiv(); const v= div ? chaos/(+$('divRate').value||1) : chaos;
  const suf= div?'d':'c';
  let s;
  if(Math.abs(v)>=1000) s=Math.round(v).toLocaleString();
  else if(Math.abs(v)>=10) s=v.toFixed(0);
  else s=v.toFixed(2);
  return s+suf;
}
function fmtSigned(chaos){
  if(chaos==null) return '<span class="dim">–</span>';
  const cls = chaos>0?'pos':(chaos<0?'neg':'');
  const sign = chaos>0?'+':'';
  return `<span class="${cls}">${sign}${fmt(chaos).replace(/^\+?/,'')}</span>`;
}
// plain-text (no HTML) — for title tooltips
function fmtP(chaos){
  if(chaos==null) return '–';
  const div=unitDiv(); const v= div ? chaos/(+$('divRate').value||1) : chaos;
  const suf= div?'d':'c';
  let s;
  if(Math.abs(v)>=1000) s=Math.round(v).toLocaleString();
  else if(Math.abs(v)>=10) s=v.toFixed(0);
  else s=v.toFixed(2);
  return s+suf;
}

// ---------- columns (built per tab; q = quality-aware) ----------
let SORT = { key:'vaalEV', dir:-1 };
const CAT_LABEL = { normal:'normal', transfigured:'transfigured', exceptional:'exceptional', meta:'Empower/Enlighten/Enhance/Eclipse' };

// user-toggleable columns (order matches display); hidden-by-default set per the user
const COL_TOGGLES = [
  {id:'conf',       label:'Confidence'},
  {id:'buy',        label:'Buy-in'},
  {id:'leveled',    label:'Leveled'},
  {id:'levelProfit',label:'Level profit'},
  {id:'xp',         label:'Leveling (XP tier)'},
  {id:'adjProfit',  label:'Time-adj. profit'},
  {id:'prize',      label:'+1 / 20q prize'},
  {id:'p23',        label:'+1 / 23q (double-corrupt)'},
  {id:'p20disp',    label:'Vaal-version +1 / 20q'},
  {id:'fail',       label:'Fail value'},
  {id:'vaalEV',     label:'Vaal EV'},
  {id:'adjVaal',    label:'Vaal ÷ time'},
  {id:'dblEV',      label:'Double EV'},
  {id:'adjDbl',     label:'Double ÷ time'},
  {id:'liq',        label:'Listings'},
];
const COL_DEFAULT_HIDDEN = new Set(['p23','p20disp']);   // double-corrupt + 21/20 display copy off by default
let COLVIS = load('gpc_colvis', {});
const colVisible = (id)=> COLVIS[id] ?? !COL_DEFAULT_HIDDEN.has(id);
let BLACKLIST = load('gpc_blacklist', {});   // { gemId: 1 } — ignored gems (sent to bottom, greyed)
function buildColToggles(){
  const box=$('colToggles'); if(!box) return;
  box.innerHTML = COL_TOGGLES.map(c=>
    `<label class="chk"><input type="checkbox" data-col="${c.id}" ${colVisible(c.id)?'checked':''}/> ${c.label}</label>`
  ).join('');
  box.querySelectorAll('input[data-col]').forEach(inp=> inp.onchange=()=>{
    COLVIS[inp.dataset.col]=inp.checked; save('gpc_colvis',COLVIS); if(GEMS.length) renderTable();
  });
}

function buildCols(mode, showAdj, plus){
  const qa = mode !== 'meta';
  const qtxt = qa ? ', 20% quality' : '';
  const corrupt = qa ? 'Corrupt it (20% quality)' : 'Corrupt it';
  const p20lbl = qa ? `${plus}/20` : 'Prize';   // level-aware: 21/20 normal, 4/20 exceptional
  const p23lbl = `${plus}/23`;
  const cols = [
    {name:true, grp:'', label:'Gem'},
    {id:'conf', conf:true, grp:'', label:'Conf', sk:'conf',
      info:'Confidence in this gem’s prices, from how many poe.ninja listings back them. Green = high (&gt;10), amber = medium (4–10), red = low (≤3). Uses the weakest of Buy-in / Leveled / Prize; hover for the breakdown.'},
    {id:'buy', grp:'Level it yourself', label:'Buy-in', price:'buy', ovr:'buyField', sk:'buy',
      info:'What you pay up front — the level-1 gem (0% quality where it exists).'},
    {id:'buy', tradeFor:'buy', grp:'Level it yourself', label:''},
    {id:'leveled', grp:'Level it yourself', label:'Leveled', price:'leveled', ovr:'leveledField', sk:'leveled',
      info:'poe.ninja price once leveled to max level. Uses 0% quality when the gem trades there, otherwise the 20% price (many low-level supports only sell at 20q).'},
    {id:'leveled', tradeFor:'leveled', grp:'Level it yourself', label:''},
    {id:'levelProfit', grp:'Level it yourself', label:'Level profit', signed:'levelProfit', sk:'levelProfit',
      info:'Leveled − Buy-in (minus GCP if the leveled price is a 20q one). Profit from leveling it yourself.'},
    {id:'xp', grp:'Level it yourself', label:'Leveling', badge:true, sk:'xp',
      info:'How much XP it takes to level to max, as Fast / Normal / Hard / Brutal (vs a normal L20 gem ≈240M). Exceptional & Empower-tier ≈1.67B to L3 (~7×); Awakened ≈2B. On the Empower-tier tab the badge follows your Leveling-quality bracket. Hover a badge for the gem’s figure and how many times a normal gem it is.'},
    {id:'adjProfit', grp:'Level it yourself', label:'Time-adj. profit', signed:'adjProfit', sk:'adjProfit', when:'adj',
      info:'Level profit ÷ the gem’s grind multiple (XP-to-max vs a normal gem) — profit per unit of leveling time. A gem that takes 7× as long has its leveling profit divided by 7, so slow gems compare fairly against fast ones. Hidden on the Normal tab (normal gems are the 1× baseline, so it equals Level profit). Empower-tier uses your Leveling-quality bracket.'},
    {id:'prize', grp:corrupt, label:p20lbl, price:'prize', ovr:'prizeField', sk:'prize', divider:true,
      info:'Market price of the corrupted +1-level'+qtxt+' gem — the standard corruption prize (single Vaal target).'},
    {id:'prize', tradeFor:'prize', grp:corrupt, label:''},
    {id:'p23', grp:corrupt, label:p23lbl, price:'p23', ovr:'p23Field', sk:'p23', when:'q23',
      info:'poe.ninja price of the double-corrupt jackpot: +1 level AND 23% quality, corrupted — the best a double corrupt can roll. Only a fraction of double corrupts hit both; this is the ceiling value, worth checking on the trade site. (Off by default — enable in ⚙ Settings → Columns.)'},
    {id:'p23', tradeFor:'p23', grp:corrupt, when:'q23', label:''},
    {id:'p20disp', grp:corrupt, label:'Vaal '+p20lbl, plainMetric:'vaalPrize', sk:'vaalPrize', when:'vaal',
      info:'Price of the gem’s VAAL counterpart at +1 level / 20% quality (e.g. Vaal Blade Vortex, not Blade Vortex). Turning into the Vaal version is a possible corruption outcome, so a Vaal 21/20 usually needs a double corrupt. Display-only (never affects EV) but sortable. Blank if the gem has no Vaal version. Off by default — enable in ⚙ Settings → Columns.'},
    {id:'fail', grp:corrupt, label:'Fail value', plainMetric:'fail',
      info:'What you keep if the corruption does NOT add a level (same level'+qtxt+', corrupted) — you resell it. Controlled by "Failed-corruption resale".'},
    {id:'vaalEV', grp:corrupt, label:'Vaal EV', ev:['evVaal','winVaal','pV','invVaal','prize'], sk:'vaalEV',
      info:'Average profit per Vaal Orb. The % chance hits the Prize; the rest resell at Fail value. Cost = EV base'+(qa?' + GCP for quality':'')+' + 1 Vaal. Sub-line: hit chance · expected net spend to make one +1 (hover the cell for the full breakdown).'},
    {id:'adjVaal', grp:corrupt, label:'Vaal ÷ time', signed:'adjVaal', sk:'adjVaal', when:'adj',
      info:'Vaal EV ÷ the gem’s leveling grind — corruption profit per unit of leveling time (most accurate when you self-level, EV base = Buy-in). Hidden on the Normal tab (grind 1×, so it equals Vaal EV).'},
    {id:'dblEV', grp:corrupt, label:'Double EV', ev:['evDbl','winDbl','pD','invDbl','prize'], sk:'dblEV',
      info:'Average profit per Temple double-corrupt — higher hit chance, and its own cost (both editable in Assumptions). Sub-line: hit chance · expected net spend per +1.'},
    {id:'adjDbl', grp:corrupt, label:'Double ÷ time', signed:'adjDbl', sk:'adjDbl', when:'adj',
      info:'Double EV ÷ the gem’s leveling grind — double-corrupt profit per unit of leveling time. Hidden on the Normal tab (grind 1×, so it equals Double EV).'},
    {id:'liq', grp:'', label:'Listings', plainLiq:true, sk:'liquidity',
      info:'poe.ninja listing count — higher = more reliable price, easier to buy & sell.'},
  ];
  return cols.filter(c => {
    if(c.when==='adj' && !showAdj) return false;   // Time-adj columns: hidden on Normal (1× baseline)
    if(c.when==='q23' && !qa) return false;         // 21/23 double-corrupt: quality tabs only
    if(c.when==='vaal' && (CAT==='exceptional'||CAT==='meta')) return false;  // Vaal column: support tabs have no Vaal gems
    if(c.id && !colVisible(c.id)) return false;     // user column-visibility toggles
    return true;
  });
}
function sortValue(g, m, key){
  switch(key){
    case 'buy':         return m.buy;
    case 'leveled':     return m.leveled;
    case 'levelProfit': return m.levelProfit;
    case 'adjProfit':   return m.adjProfit;
    case 'xp':          return g.xpEst;
    case 'prize':       return m.prize;
    case 'p23':         return m.p23;
    case 'vaalPrize':   return m.vaalPrize;
    case 'vaalEV':      return m.evVaal;
    case 'adjVaal':     return m.adjVaal;
    case 'dblEV':       return m.evDbl;
    case 'adjDbl':      return m.adjDbl;
    case 'liquidity':   return g.maxList;
    case 'conf':        return m.confCount;
    case 'name':        return g.name;
    default:            return m.evVaal;
  }
}
const infoIcon = (t)=> `<span class="ci" title="${t.replace(/"/g,'&quot;')}">&#9432;</span>`;
function plusLevelFor(gems){   // most common (maxLvl+1) among a category's gems, for level-aware labels
  if(!gems.length) return 21;
  const counts={};
  for(const g of gems) counts[g.maxLvl+1] = (counts[g.maxLvl+1]||0)+1;
  return +Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
}
// confidence badge for the dedicated column: green (high) / amber (medium) / red (low)
function confBadge(m){
  const tier=m.confTier;
  const cls={high:'cf-high',med:'cf-med',low:'cf-low',none:'cf-none'}[tier]||'cf-none';
  const label={high:'High',med:'Medium',low:'Low',none:'no data'}[tier]||'no data';
  const n=x=>x==null?'–':x;
  const tip = tier==='none' ? 'no poe.ninja listing data'
    : `${label} confidence — weakest priced listing ${m.confCount} (buy ${n(m.buyList)} · leveled ${n(m.leveledList)} · prize ${n(m.prizeList)})`;
  return `<span class="cf-big ${cls}" title="${tip}">&#9679;</span>`;
}
// bigger trade link for the dedicated trade columns
function tradeCell(g, field){
  if(!(field in TRADE_FIELDS)) return '';
  const p=tradeParams(g,field); if(!p) return '';
  return `<a class="trd-cell" href="${tradeUrl(g,p[0],p[1],p[2])}" target="_blank" rel="noopener" title="Find this on pathofexile.com/trade">&#8599;</a>`;
}
function xpShort(n){
  if(n>=1e9) return (n/1e9).toFixed(2).replace(/\.?0+$/,'')+'B';
  if(n>=1e6) return Math.round(n/1e6)+'M';
  return Math.round(n).toLocaleString();
}
// XP badge for one gem, taking the Empower-tier leveling-quality bracket into account
function xpBadge(g, a){
  let est=g.xpEst, lead;
  if(g.cat==='meta'){
    const q=a.metaQuality, inc=0.05*q;                 // 5% increased exp per 1% quality
    est = g.xpEst/(1+inc);
    lead = `Empower-tier at ${q}% quality (+${Math.round(inc*100)}% experience): ~${xpShort(est)} effective XP to level 3 (base ~1.67B; each 1% quality = 5% increased exp)`;
  } else if(g.cat==='exceptional'){
    lead = `Exceptional gem: ~${xpShort(est)} XP to level 3`;
  } else if(/^Awakened /.test(g.name)){
    lead = `Awakened gem: ~${xpShort(est)} XP to level 5`;
  } else {
    lead = `Standard gem: ~${xpShort(est)} XP to level 20`;
  }
  const r = est/NORMAL_XP;
  const cmp = r>=1.05 ? ` — about ${r.toFixed(1)}× the grind of a normal level-20 gem`
            : r<=0.95 ? ` — about ${(1/r).toFixed(1)}× faster than a normal level-20 gem`
            : ` — about the same grind as a normal level-20 gem`;
  const tier = xpTierFor(est);
  const note = lead + cmp + '.';
  return `<span class="xp-badge xp-${tier.toLowerCase()}" title="${note.replace(/"/g,'&quot;')}">${tier}</span>`;
}

function renderTable(){
  if(MODE==='scarabs') return;   // scarab view owns the page; render() handles the switch
  const a=readAssume();
  $('metaControls').classList.toggle('hidden', CAT!=='meta');   // Empower-tier quality controls
  $('qualControls').classList.toggle('hidden', CAT==='meta');  // 20q toggle (quality tabs + Top picks)
  const wrap=document.querySelector('.tablewrap');
  if(CAT==='top'){
    $('dash').classList.remove('hidden'); wrap.classList.add('hidden');
    $('rowCount').textContent='';
    renderDashboard(a);
    return;
  }
  $('dash').classList.add('hidden'); wrap.classList.remove('hidden');

  const tbl=$('tbl');
  const mode = CAT === 'meta' ? 'meta' : 'quality';
  const plus = plusLevelFor(GEMS.filter(g=>g.cat===CAT));   // +1 level for labels (21 normal, 4 exceptional)
  const showAdj = CAT!=='normal' && CAT!=='transfigured';   // grind=1 on both, so Time-adj cols are redundant
  const cols = buildCols(mode, showAdj, plus);

  // header: group row + column row
  let grpRow='<tr>', colRow='<tr>';
  let i=0;
  while(i<cols.length){
    const c=cols[i];
    let span=1; while(i+span<cols.length && cols[i+span].grp===c.grp && c.grp!=='') span++;
    grpRow += c.grp==='' ? `<th class="${c.name?'name':''}"></th>` : `<th class="grp" colspan="${span}">${c.grp}</th>`;
    for(let j=0;j<span;j++){
      const cc=cols[i+j];
      const cls=[cc.name?'name':'', cc.divider?'divider':'', cc.sk?'sortable':''].filter(Boolean).join(' ');
      const arrow = (cc.sk && SORT.key===cc.sk) ? `<span class="arr">${SORT.dir<0?'▼':'▲'}</span>` : '';
      const data = cc.sk ? ` data-sk="${cc.sk}"` : '';
      colRow += `<th class="${cls}"${data}>${cc.label}${cc.info?infoIcon(cc.info):''}${arrow}</th>`;
    }
    i+=span;
  }
  grpRow+='</tr>'; colRow+='</tr>';

  // filter
  const qstr=$('search').value.trim().toLowerCase();
  const minL=+$('minList').value||0;
  let rows=GEMS.filter(g=> g.cat===CAT)
               .filter(g=> !qstr || g.name.toLowerCase().includes(qstr))
               .filter(g=> g.maxList>=minL);
  const metricsById={};
  rows.forEach(g=> metricsById[g.id]=computeMetrics(g,a,mode));

  // confidence filter (needs metrics)
  const cf=$('confFilter').value;
  if(cf!=='any') rows=rows.filter(g=>{ const c=metricsById[g.id].confCount; return c!=null && (cf==='high'?c>10:c>3); });

  // sort
  if(SORT.key==='name'){
    rows.sort((x,y)=> SORT.dir * x.name.localeCompare(y.name));
  } else {
    rows.sort((x,y)=>{
      const A=sortValue(x,metricsById[x.id],SORT.key), B=sortValue(y,metricsById[y.id],SORT.key);
      if(A==null&&B==null) return 0; if(A==null) return 1; if(B==null) return -1;
      return SORT.dir*(A-B);
    });
  }
  // ignored gems sink to the bottom (stable — keeps the sort order within each group)
  rows.sort((x,y)=> (BLACKLIST[x.id]?1:0) - (BLACKLIST[y.id]?1:0));

  const shown = rows;
  $('rowCount').textContent = `${rows.length} ${CAT_LABEL[CAT]} gems`;

  // body
  let body='';
  for(const g of shown){
    const m=metricsById[g.id];
    let tds='';
    for(const c of cols){
      const dv = c.divider ? ' divider' : '';
      if(c.name){
        const bl = !!BLACKLIST[g.id];
        tds+=`<td class="name"><div class="gemname">`+
             (g.icon?`<img src="${g.icon}" loading="lazy" alt="">`:'')+
             `<span title="base L${g.baseLvl} → max L${g.maxLvl}${g.topQ?` / up to ${g.topQ}q`:''}; corrupt target L${g.maxLvl+1}">${g.name}</span>`+
             `<button class="blk-btn" data-blk="${g.id}" title="${bl?'Track this gem again':'Ignore this gem (send to bottom)'}">${bl?'↺':'⊘'}</button>`+
             `</div></td>`;
      } else if(c.badge){
        tds+=`<td class="${dv.trim()}">${xpBadge(g,a)}</td>`;
      } else if(c.conf){
        tds+=`<td class="conf-cell">${confBadge(m)}</td>`;
      } else if(c.tradeFor){
        const tf=c.tradeFor;
        const field = tf==='buy'?'buy' : tf==='leveled'?m.leveledField : tf==='prize'?m.prizeField : 'P23';
        tds+=`<td class="trd-col${dv}">${tradeCell(g, field)}</td>`;
      } else if(c.plainLiq){
        tds+=`<td class="dim">${g.maxList}</td>`;
      } else if(c.plainMetric){
        tds+=`<td class="dim${dv}">${fmt(m[c.plainMetric])}</td>`;
      } else if(c.price){
        const field = m[c.ovr];
        const has = field && OVER[`${g.id}::${field}`]!=null;
        tds+=`<td class="ovr-cell${has?' has-ovr':''}${dv}" data-id="${g.id}" data-field="${field}" `+
             `title="double-click to set a manual override">${fmt(m[c.price])}</td>`;
      } else if(c.signed){
        tds+=`<td class="${dv.trim()}">${fmtSigned(m[c.signed])}</td>`;
      } else if(c.ev){
        const [evK,winK,pK,invK,prizeK]=c.ev;
        const ev=m[evK], win=m[winK], inv=m[invK], prize=m[prizeK], p=a[pK];
        if(ev==null){ tds += `<td class="ev${dv}"><span class="dim">–</span></td>`; }
        else{
          const tries = p>0 ? (1/p) : null;
          const profitPer = p>0 ? ev/p : null;
          const tip = `${(p*100).toFixed(1)}% chance per attempt · `+
            `≈${tries?tries.toFixed(1):'∞'} attempts to make one +1 · `+
            `net invest ≈${fmtP(inv)} → +1 worth ${fmtP(prize)} · `+
            `profit per +1 ≈${fmtP(profitPer)} · profit if a single try hits ${fmtP(win)}`;
          tds += `<td class="ev${dv}" title="${tip.replace(/"/g,'&quot;')}">${fmtSigned(ev)}`+
                 `<span class="sub2">${(p*100).toFixed(1)}% · ${fmtP(inv)}/+1</span></td>`;
        }
      }
    }
    body+=`<tr class="${BLACKLIST[g.id]?'blk':''}">${tds}</tr>`;
  }
  tbl.innerHTML=`<thead>${grpRow}${colRow}</thead><tbody>${body}</tbody>`;
}

// ---------- "Top picks" dashboard ----------
const CAT_TAG = { normal:'Normal', transfigured:'Transfigured', exceptional:'Exceptional', meta:'Empower-tier' };
function renderDashboard(a){
  const minL = +$('minList').value||0;
  let rows = GEMS.filter(g=>g.maxList>=minL && !BLACKLIST[g.id])
                 .map(g=>({g, m:computeMetrics(g, a, g.cat==='meta'?'meta':'quality')}));
  const cf=$('confFilter').value;   // honour the confidence filter so top picks aren't faked by thin prices
  if(cf!=='any') rows=rows.filter(x=>{ const c=x.m.confCount; return c!=null && (cf==='high'?c>10:c>3); });
  const lists = [
    {title:'Best to level — profit',            sub:'Level profit',                       val:x=>x.m.levelProfit},
    {title:'Best to level — profit ÷ time',     sub:'Level profit per unit leveling time',val:x=>x.m.adjProfit},
    {title:'Best single Vaal corrupt',          sub:'Vaal EV / attempt',                  val:x=>x.m.evVaal},
    {title:'Best single Vaal ÷ time',           sub:'Vaal EV per unit leveling time',     val:x=>x.m.adjVaal},
    {title:'Best double corrupt',               sub:'Double EV / attempt',                val:x=>x.m.evDbl},
    {title:'Best double corrupt ÷ time',        sub:'Double EV per unit leveling time',   val:x=>x.m.adjDbl},
    {title:'Biggest +1 prize',                  sub:'Corrupted +1 level / 20q value',     val:x=>x.m.prize, plain:true},
    {title:'Biggest +1/23 prize',               sub:'Double-corrupt +1 level / 23q value',val:x=>x.m.p23, plain:true},
    {title:'Biggest Vaal +1 prize',             sub:'Vaal-counterpart +1 level / 20q value', val:x=>x.m.vaalPrize, plain:true},
  ];
  let html='<div class="dash-grid">';
  for(const L of lists){
    const top = rows.filter(x=>L.val(x)!=null).sort((p,q)=>L.val(q)-L.val(p)).slice(0,10);
    html += `<div class="dash-card"><h3>${L.title}</h3><div class="dash-sub">${L.sub}</div><ol>`;
    for(const x of top){
      const v = L.plain ? fmt(L.val(x)) : fmtSigned(L.val(x));
      html += `<li data-cat="${x.g.cat}" data-name="${x.g.name.replace(/"/g,'&quot;')}" title="open in ${CAT_TAG[x.g.cat]} tab">`+
              `<span class="dn">${x.g.icon?`<img src="${x.g.icon}" loading="lazy" alt="">`:''}${x.g.name}</span>`+
              `<span class="dv">${v}<span class="dtag">${CAT_TAG[x.g.cat]}</span></span></li>`;
    }
    if(!top.length) html += '<li class="dim">no data yet</li>';
    html += '</ol></div>';
  }
  html += '</div>';
  $('dash').innerHTML = html;
}
function syncSearchClear(){
  const b=$('searchClear'); if(b) b.classList.toggle('hidden', !$('search').value);
}
function onDashClick(e){
  const li=e.target.closest('li[data-cat]'); if(!li) return;
  const cat=li.dataset.cat, name=li.dataset.name;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.cat===cat));
  CAT=cat; $('search').value=name; syncSearchClear(); saveSettings(); renderTable();
}

// ignore / track toggle (blacklist)
function onBlacklistClick(e){
  const b=e.target.closest('[data-blk]'); if(!b) return;
  e.stopPropagation();
  const id=b.dataset.blk;
  if(BLACKLIST[id]) delete BLACKLIST[id]; else BLACKLIST[id]=1;
  save('gpc_blacklist', BLACKLIST);
  updateBlkCount();
  renderTable();
}
function updateBlkCount(){
  const el=$('blkCount'); if(el) el.textContent = Object.keys(BLACKLIST).length;
}

// header click → sort
function onHeaderClick(e){
  const th=e.target.closest('th[data-sk]'); if(!th) return;
  const sk=th.dataset.sk;
  if(SORT.key===sk) SORT.dir=-SORT.dir;
  else { SORT.key=sk; SORT.dir = sk==='name'?1:-1; }
  const sel=$('sort'); if([...sel.options].some(o=>o.value===sk)) sel.value=sk;
  renderTable();
}

// ---------- override editing ----------
function onCellDblClick(e){
  const cell=e.target.closest('.ovr-cell'); if(!cell) return;
  const id=cell.dataset.id, field=cell.dataset.field;
  const g=GEMS.find(x=>x.id===id); if(!g) return;
  const cur = OVER[`${id}::${field}`] ?? g.raw[field];
  const inp=document.createElement('input');
  inp.type='number'; inp.step='0.1'; inp.value=(cur==null?'':cur); inp.style.width='6em';
  cell.textContent=''; cell.appendChild(inp); inp.focus(); inp.select();
  const commit=()=>{
    const v=num(inp.value);
    if(v==null) delete OVER[`${id}::${field}`]; else OVER[`${id}::${field}`]=v;
    save(LS.overrides, OVER);
    renderTable();
  };
  inp.addEventListener('blur', commit, {once:true});
  inp.addEventListener('keydown', ev=>{ if(ev.key==='Enter') inp.blur(); if(ev.key==='Escape'){ inp.value=(cur==null?'':cur); inp.blur(); } });
}

// ---------- data ingestion ----------
function ingest(gemsJson, currJson, meta){
  const gLines = gemsJson?.lines || [];
  if(!gLines.length) throw new Error('No "lines" array found in gems JSON.');
  GEMS = buildGems(gLines);
  if(currJson?.lines){
    CURR = buildCurrency(currJson.lines);
    if(CURR.gcp!=null){ $('gcpCost').value=round2(CURR.gcp); $('srcGcp').textContent='(live)'; }
    if(CURR.vaal!=null){ $('vaalCost').value=round2(CURR.vaal); $('srcVaal').textContent='(live)'; }
    if(CURR.div!=null){ $('divRate').value=round2(CURR.div); $('srcDiv').textContent='(live)'; }
  }
  // cache slimmed
  try{
    const slimG={lines:gLines.map(l=>({name:l.name,icon:l.icon,variant:l.variant,chaosValue:l.chaosValue,listingCount:l.listingCount}))};
    const slimC=currJson?.lines?{lines:currJson.lines.map(l=>({currencyTypeName:l.currencyTypeName,chaosEquivalent:l.chaosEquivalent}))}:null;
    save(LS.data,{g:slimG,c:slimC,meta:{...meta,when:Date.now()}});
  }catch(e){ /* too big for quota — fine */ }
  saveSettings();
  render();
  META_INFO = meta || null;
  updateFreshness();
  updateTempleLinks();
  setStatus(`Loaded ${GEMS.length} leveling-viable gems for ${meta.league}`, 'ok');
}
const round2=(v)=>Math.round(v*100)/100;

function setStatus(msg, cls){ const s=$('status'); s.innerHTML=msg; s.className='status'+(cls?' '+cls:''); }

// ---------- data freshness / next-update countdown ----------
let META_INFO = null;         // last-loaded {league, game, when}
let IS_STATIC_HOST = false;   // true on GitHub Pages (data on a fixed schedule)
const UPDATE_MINUTES = [7, 22, 37, 52];  // MUST match cron in .github/workflows/deploy-pages.yml
function fmtDur(ms){
  const m = Math.max(0, Math.round(ms/60000));
  return m<60 ? m+'m' : Math.floor(m/60)+'h '+(m%60)+'m';
}
function nextScheduledUpdate(from){   // next UTC time whose minute is in UPDATE_MINUTES
  for(let i=1;i<=120;i++){
    const t=new Date(from + i*60000);
    if(UPDATE_MINUTES.includes(t.getUTCMinutes())){ t.setUTCSeconds(0,0); return t; }
  }
  return null;
}
function updateFreshness(){
  const el=$('freshness'); if(!el) return;
  if(!META_INFO || !META_INFO.when){ el.textContent=''; return; }
  let txt = 'prices ' + fmtDur(Date.now()-META_INFO.when) + ' old';
  if(IS_STATIC_HOST){
    const nxt = nextScheduledUpdate(Date.now());
    if(nxt) txt += ' · next ~' + nxt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + ' (in ' + fmtDur(nxt-Date.now()) + ')';
  }
  el.textContent = txt;
}

// ---------- URLs ----------
function apiBase(){ return `https://poe.ninja/${GAME}/api/economy/stash/current`; }
function gemsUrl(){ return `${apiBase()}/item/overview?league=${encodeURIComponent($('league').value)}&type=SkillGem`; }
function currUrl(){ return `${apiBase()}/currency/overview?league=${encodeURIComponent($('league').value)}&type=Currency`; }
function refreshLinks(){ $('lnkGems').href=gemsUrl(); $('lnkCurr').href=currUrl(); }

// ---------- trade links (pathofexile.com/trade) ----------
let TRADEMAP = {};   // gem name -> {t:type, d?:discriminator}
const TRADE_FIELDS = { buy:'baseLvl0', L0:'max0', L20:'max20', P0:'p0', P20:'p20', P23:'p23' };
function tradeParams(g, field){
  switch(field){
    case 'buy': return [g.baseLvl, 0, false];
    case 'L0':  return [g.maxLvl, 0, false];
    case 'L20': return [g.maxLvl, 20, false];
    case 'P0':  return [g.maxLvl+1, 0, true];
    case 'P20': return [g.maxLvl+1, 20, true];
    case 'P23': return [g.maxLvl+1, 23, true];
    default: return null;
  }
}
function tradeUrl(g, level, quality, corrupted){
  const league = (META_INFO && META_INFO.league) || $('league').value || 'Standard';
  const t = TRADEMAP[g.name];
  const type = t ? (t.d ? {option:t.t, discriminator:t.d} : t.t) : g.name;   // fallback: plain name
  const filters = { gem_level:{min:level}, corrupted:{option: corrupted?'true':'false'} };
  filters.quality = quality>0 ? {min:quality} : {max:0};   // 0q cells search exactly 0 quality
  const q = { query:{ status:{option:'securable'}, type, filters:{misc_filters:{filters}} }, sort:{price:'asc'} };
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}?q=${encodeURIComponent(JSON.stringify(q))}`;
}
function tradeIcon(g, field){
  if(!(field in TRADE_FIELDS)) return '';
  const p = tradeParams(g, field); if(!p) return '';
  return `<a class="trd" href="${tradeUrl(g,p[0],p[1],p[2])}" target="_blank" rel="noopener" `+
         `title="Find this on pathofexile.com/trade" onclick="event.stopPropagation()">&#8599;</a>`;
}
// double-corrupt temple: Chronicle of Atzoatl with an open Doryani's Institute (Tier 3) room (double-corrupts gems)
function templeTradeUrl(){
  const league = (META_INFO && META_INFO.league) || $('league').value || 'Standard';
  const q = { query:{ status:{option:'securable'}, type:'Chronicle of Atzoatl',
    stats:[{type:'and', filters:[{id:'pseudo.pseudo_temple_gem_room_3', value:{option:1}}]}] },
    sort:{price:'asc'} };
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}?q=${encodeURIComponent(JSON.stringify(q))}`;
}
function updateTempleLinks(){
  const url=templeTradeUrl();
  document.querySelectorAll('.temple-trade').forEach(a=> a.href=url);
}

// ---------- league dropdown ----------
function ensureLeagueOption(name){
  if(!name) return;
  const sel=$('league');
  if(![...sel.options].some(o=>o.value===name)){
    const o=document.createElement('option'); o.value=name; o.textContent=name; sel.appendChild(o);
  }
}
async function populateLeagues(){
  const sel=$('league'); if(!sel) return;
  let leagues=[{name:'Standard',slug:'standard'},{name:'Hardcore',slug:'hardcore'}];
  try{ const r=await fetch('json/leagues.json',{cache:'no-store'}); if(r.ok){ const j=await r.json(); if(Array.isArray(j)&&j.length) leagues=j.map(x=> typeof x==='string'?{name:x,slug:null}:x); } }catch{}
  LEAGUE_SLUG={}; sel.innerHTML='';
  for(const {name,slug} of leagues){ LEAGUE_SLUG[name]=slug; const o=document.createElement('option'); o.value=name; o.textContent=name; sel.appendChild(o); }
  const saved=(load(LS.settings,{})||{}).league;
  if(saved && (saved in LEAGUE_SLUG)) sel.value=saved;
  refreshLinks();
}

async function fetchLive(){
  setStatus('Attempting live fetch…');
  try{
    const [gr,cr]=await Promise.all([fetch(gemsUrl()), fetch(currUrl()).catch(()=>null)]);
    const gj=await gr.json();
    const cj=cr?await cr.json().catch(()=>null):null;
    ingest(gj,cj,{league:$('league').value,game:GAME});
    $('loader').classList.add('hidden');
  }catch(err){
    setStatus('Live fetch failed (CORS-blocked, as expected for a local file). Use the manual links / paste below.','err');
    $('loader').classList.remove('hidden');
  }
}

// ---------- server mode (serve.js / start.bat) ----------
function serverMode(){ return location.protocol === 'http:' || location.protocol === 'https:'; }

async function loadFromServer(forceRefresh){
  try{
    if(forceRefresh){
      setStatus('Downloading fresh prices from poe.ninja…');
      const r = await fetch(`/api/refresh?game=${GAME}&league=${encodeURIComponent($('league').value)}`);
      const info = await r.json();
      if(!info.ok) throw new Error(info.error || 'download failed');
    }
    const gr = await fetch('json/gems.json', {cache:'no-store'});
    if(!gr.ok){
      if(!forceRefresh) return loadFromServer(true);   // nothing downloaded yet → fetch once
      throw new Error('gems.json missing after download');
    }
    const gj = await gr.json();
    let cj = null;
    try{ const cr = await fetch('json/currency.json', {cache:'no-store'}); if(cr.ok) cj = await cr.json(); }catch{}
    let meta = {league:$('league').value, game:GAME};
    try{ const mr = await fetch('json/meta.json', {cache:'no-store'}); if(mr.ok){ const m = await mr.json(); if(m.when) meta.when=m.when; } }catch{}
    await loadScarabs(null);   // local serve.js writes slugless json/scarabs.json
    ingest(gj, cj, meta);
    $('loader').classList.add('hidden');
  }catch(e){
    // fall back to any cached data, else the manual loader
    const cached = load(LS.data, null);
    if(cached?.g){ try{ ingest(cached.g, cached.c, cached.meta||{}); }catch{} }
    setStatus('Auto-download failed: ' + e.message + ' — showing last data / use manual load below.', 'err');
    $('loader').classList.remove('hidden');
  }
}

// Static host (e.g. GitHub Pages): no local API. Just load the committed/deployed json/ data.
async function loadStaticData(leagueName){
  try{
    let meta={}; try{ meta=await (await fetch('json/meta.json',{cache:'no-store'})).json(); }catch{}
    const name = leagueName || $('league').value || meta.defaultLeague;
    const slug = LEAGUE_SLUG[name] || (name===meta.defaultLeague ? meta.defaultSlug : null) || meta.defaultSlug;
    if(name){ ensureLeagueOption(name); $('league').value=name; }
    setStatus(`Loading ${name}…`);
    const gr = await fetch(`json/gems-${slug}.json`, {cache:'no-store'});
    if(!gr.ok) throw new Error('no data for '+name);
    const gj = await gr.json();
    let cj = null;
    try{ const cr = await fetch(`json/currency-${slug}.json`, {cache:'no-store'}); if(cr.ok) cj = await cr.json(); }catch{}
    await loadScarabs(slug);
    ingest(gj, cj, {league:name, game:meta.game||GAME, when:meta.when});
    $('loader').classList.add('hidden');
  }catch(e){
    const cached = load(LS.data, null);
    if(cached?.g){ try{ ingest(cached.g, cached.c, cached.meta||{}); }catch{} }
    setStatus('No price data available yet ('+e.message+'). Try again shortly, or use manual load below.','err');
    $('loader').classList.remove('hidden');
  }
}

function readFileText(input){
  return new Promise((res,rej)=>{
    const f=input.files&&input.files[0]; if(!f) return res(null);
    const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsText(f);
  });
}
async function applyPaste(){
  try{
    let gTxt=$('pasteGems').value.trim() || await readFileText($('fileGems'));
    let cTxt=$('pasteCurr').value.trim() || await readFileText($('fileCurr'));
    if(!gTxt) throw new Error('Provide the Skill Gems JSON (paste or file).');
    const gj=JSON.parse(gTxt);
    const cj=cTxt?JSON.parse(cTxt):null;
    ingest(gj,cj,{league:$('league').value,game:GAME});
    $('loader').classList.add('hidden');
  }catch(err){ setStatus('Could not parse JSON: '+err.message,'err'); }
}

// ---------- double-corrupt cost warning ----------
function updateDblWarn(){
  const zero = (+$('dblCost').value || 0) <= 0;
  $('dblCost').classList.toggle('bad-input', zero);
  $('dblWarn').textContent = zero
    ? '⚠ never free — a real double corrupt costs currency; leave it at 0 and Double EV is too optimistic'
    : '';
}

// ---------- auto-refresh ----------
let autoTimer = null;
function setupAutoRefresh(){
  if(autoTimer){ clearInterval(autoTimer); autoTimer=null; }
  if(!serverMode() || !$('autoRefresh').checked) return;
  const mins = Math.max(1, +$('autoMin').value || 0);
  autoTimer = setInterval(()=>{ loadFromServer(true); }, mins*60*1000);
}

// ============================================================================
//  SCARABS  (ported from the poe.ninja-scarab-groups userscript)
//  Scarabs are bucketed by league mechanic; each group shows total / median /
//  raw-avg / rarity-weighted-avg. Prices reuse the app's fmt() (unit + divRate).
// ============================================================================

// Scarab drop rarity, scraped once from poedb.tw. Rarity is a fixed game property,
// so this static table stays valid across leagues. Unknown scarabs -> "common".
const SCARAB_RARITY = {
  "Abyss Scarab": "common", "Abyss Scarab of Crystals": "rare", "Abyss Scarab of Descending": "rare", "Abyss Scarab of Multitudes": "uncommon", "Abyss Scarab of the Consort": "mythic",
  "Ambush Scarab": "common", "Ambush Scarab of Containment": "mythic", "Ambush Scarab of Discernment": "rare", "Ambush Scarab of Hidden Compartments": "uncommon", "Ambush Scarab of Potency": "uncommon",
  "Anarchy Scarab": "common", "Anarchy Scarab of Gigantification": "uncommon", "Anarchy Scarab of Partnership": "rare", "Anarchy Scarab of the Exceptional": "rare",
  "Bestiary Scarab": "common", "Bestiary Scarab of Duplicating": "rare", "Bestiary Scarab of the Herd": "uncommon",
  "Betrayal Scarab": "common", "Betrayal Scarab of Reinforcements": "uncommon", "Betrayal Scarab of Unbreaking": "rare", "Betrayal Scarab of the Allflame": "uncommon",
  "Beyond Scarab": "common", "Beyond Scarab of Haemophilia": "rare", "Beyond Scarab of Resurgence": "rare", "Beyond Scarab of the Invasion": "rare",
  "Blight Scarab": "common", "Blight Scarab of Blooming": "mythic", "Blight Scarab of Invigoration": "mythic", "Blight Scarab of the Blightheart": "rare",
  "Breach Scarab of Instability": "uncommon", "Breach Scarab of Resonant Cascade": "mythic", "Breach Scarab of the Hive": "common", "Breach Scarab of the Incensed Swarm": "mythic", "Breach Scarab of the Marshal": "rare",
  "Cartography Scarab of Corruption": "rare", "Cartography Scarab of Escalation": "common", "Cartography Scarab of Risk": "mythic", "Cartography Scarab of the Multitude": "uncommon",
  "Delirium Scarab": "common", "Delirium Scarab of Delusions": "rare", "Delirium Scarab of Mania": "uncommon", "Delirium Scarab of Neuroses": "rare", "Delirium Scarab of Paranoia": "uncommon",
  "Divination Scarab of Pilfering": "rare", "Divination Scarab of Plenty": "rare", "Divination Scarab of The Cloister": "common",
  "Domination Scarab": "common", "Domination Scarab of Apparitions": "uncommon", "Domination Scarab of Evolution": "rare", "Domination Scarab of Terrors": "mythic",
  "Essence Scarab": "common", "Essence Scarab of Adaptation": "mythic", "Essence Scarab of Ascent": "rare", "Essence Scarab of Calcification": "mythic", "Essence Scarab of Stability": "uncommon",
  "Expedition Scarab": "common", "Expedition Scarab of Archaeology": "rare", "Expedition Scarab of Infusion": "rare", "Expedition Scarab of Runefinding": "uncommon", "Expedition Scarab of Verisium Powder": "uncommon",
  "Harvest Scarab": "common", "Harvest Scarab of Cornucopia": "mythic", "Harvest Scarab of Doubling": "rare",
  "Horned Scarab of Awakening": "mythic", "Horned Scarab of Bloodlines": "extreme", "Horned Scarab of Glittering": "mythic", "Horned Scarab of Nemeses": "rare", "Horned Scarab of Pandemonium": "mythic", "Horned Scarab of Preservation": "extreme", "Horned Scarab of Tradition": "mythic",
  "Incursion Scarab": "common", "Incursion Scarab of Champions": "rare", "Incursion Scarab of Invasion": "uncommon", "Incursion Scarab of Timelines": "mythic",
  "Influencing Scarab of Hordes": "uncommon", "Influencing Scarab of Interference": "rare", "Influencing Scarab of the Elder": "common", "Influencing Scarab of the Shaper": "common",
  "Kalguuran Scarab": "common", "Kalguuran Scarab of Enriching": "rare", "Kalguuran Scarab of Guarded Riches": "uncommon", "Kalguuran Scarab of Refinement": "mythic",
  "Legion Scarab": "common", "Legion Scarab of Eternal Conflict": "mythic", "Legion Scarab of Officers": "rare", "Legion Scarab of Treasures": "rare",
  "Ritual Scarab of Abundance": "rare", "Ritual Scarab of Corpses": "rare", "Ritual Scarab of Selectiveness": "common", "Ritual Scarab of Wisps": "uncommon",
  "Scarab of Adversaries": "common", "Scarab of Divinity": "uncommon", "Scarab of Monstrous Lineage": "common", "Scarab of Radiant Storms": "mythic", "Scarab of Stability": "rare", "Scarab of Wisps": "rare", "Scarab of the Dextral": "rare", "Scarab of the Sinistral": "rare",
  "Sulphite Scarab": "common", "Sulphite Scarab of Fumes": "rare",
  "Titanic Scarab": "common", "Titanic Scarab of Legend": "mythic", "Titanic Scarab of Treasures": "rare",
  "Torment Scarab": "common", "Torment Scarab of Peculiarity": "uncommon", "Torment Scarab of Possession": "rare",
  "Trarthan Scarab": "common", "Trarthan Scarab of Infamy": "uncommon", "Trarthan Scarab of Renown": "rare", "Trarthan Scarab of Surprising Alliances": "mythic",
  "Ultimatum Scarab": "common", "Ultimatum Scarab of Bribing": "uncommon", "Ultimatum Scarab of Catalysing": "extreme", "Ultimatum Scarab of Dueling": "mythic", "Ultimatum Scarab of Inscription": "rare",
};
// Default relative DROP FREQUENCY per rarity (common = 1 baseline). Calibrated from a
// 3.27 sample of 33,333 drops (median drop rate per tier, normalized to common). Tunable.
const SC_WEIGHT_DEF = { common: 1.0, uncommon: 0.68, rare: 0.34, mythic: 0.06, extreme: 0.04 };
const SCARAB_RARITY_LIST = ['common', 'uncommon', 'rare', 'mythic', 'extreme'];
const SCARAB_RARITY_COLOR = { common:'#8b929c', uncommon:'#5bbf6a', rare:'#4c9be8', mythic:'#b57ae0', extreme:'#e0a13b' };
const SC_SORT_LABEL = { total:'Total', median:'Median', average:'Raw Avg', weighted:'Wtd Avg' };
const SC_METRIC_DESC = {
  total:'Total: sum of one of each scarab in this mechanic. Ranks mechanics by combined value.',
  median:'Median: the middle scarab price, ignoring a single very expensive outlier.',
  average:'Raw Avg: plain (unweighted) mean of every scarab price — no rarity weighting.',
  weighted:'Wtd Avg: rarity-weighted expected value of a random drop — rarer scarabs count less (tune weights in ⚙ Settings).',
  volume:'Volume: how much of these scarabs traded recently on poe.ninja.',
};

// scarab view state (sub-view / sort / folds / hidden / weights), persisted under one key
let SC = Object.assign({ sub:'top', sortKey:'total', sortDir:-1, folds:{}, hidden:{}, weights:{} }, load('gpc_scarab', {}) || {});
SC.weights = Object.assign({}, SC_WEIGHT_DEF, SC.weights || {});
function saveSC(){ save('gpc_scarab', SC); }

// Mechanic sets for the Top-picks dashboard (already normalized to real group names:
// trarthus→Trarthan, kalguur→Kalguuran, delve→Sulphite; heist has no scarabs so it's absent).
const SC_SET_BLOCK    = ['Breach','Legion','Expedition','Harvest','Abyss','Trarthan','Delirium','Kalguuran','Sulphite','Ritual','Blight','Ultimatum'];
const SC_SET_INCREASE = ['Ambush','Anarchy','Domination','Torment','Beyond','Essence','Titanic','Cartography','Divination'];

function scMechanicOf(name){
  if(/^Scarab of /i.test(name)) return 'Generic';
  const m = name.match(/^(.+?)\s+Scarab\b/);
  return m ? m[1] : 'Other';
}
function scRarityOf(name){ return SCARAB_RARITY[name] || 'common'; }
function scWeightOf(r){ const w = SC.weights[r]; return (typeof w==='number' && w>=0) ? w : (SC_WEIGHT_DEF[r] || 1); }
function medianOf(arr){
  if(!arr.length) return 0;
  const s = arr.slice().sort((a,b)=>a-b), mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : (s[mid-1] + s[mid]) / 2;
}
function fmtVol(n){ n = n||0; return n>=1000 ? (n/1000).toFixed(n>=10000?0:1)+'k' : String(Math.round(n)); }

// bucket rows by mechanic + compute total / median / average / weighted avg (uses current weights)
function buildScarabGroups(rows){
  const by = {};
  rows.forEach(r=>{
    const mechanic = scMechanicOf(r.name), rarity = scRarityOf(r.name);
    (by[mechanic] || (by[mechanic] = [])).push({ ...r, mechanic, rarity });
  });
  const groups = Object.keys(by).map(mechanic=>{
    const items = by[mechanic].slice().sort((a,b)=> SC.sortDir<0 ? b.chaos-a.chaos : a.chaos-b.chaos);
    const prices = items.map(i=>i.chaos);
    const total = prices.reduce((s,v)=>s+v,0);
    let wsum=0, wval=0; items.forEach(i=>{ const w=scWeightOf(i.rarity); wsum+=w; wval+=i.chaos*w; });
    return { mechanic, items, count:items.length, total,
      average: prices.length ? total/prices.length : 0,
      median: medianOf(prices),
      weighted: wsum ? wval/wsum : 0,
      volume: items.reduce((s,i)=>s+i.volume,0) };
  });
  const k = SC.sortKey;
  groups.sort((a,b)=> SC.sortDir<0 ? b[k]-a[k] : a[k]-b[k]);
  return groups;
}

function scMetric(key, label, chaos){
  const active = SC.sortKey===key;
  return `<div class="sc-metric${active?' active':''}" title="${SC_METRIC_DESC[key].replace(/"/g,'&quot;')}">`+
         `<span class="lbl">${label}</span><b>${fmt(chaos)}</b></div>`;
}
function scRarBadge(r){
  const c = SCARAB_RARITY_COLOR[r] || '#8b929c';
  return `<span class="sc-rar" title="${r} — drop weight ${scWeightOf(r)} (edit in ⚙ Settings)" `+
         `style="background:${c}22;color:${c};border:1px solid ${c}66">${r}</span>`;
}

// dispatcher: sub-view (top-picks dashboard vs full grouped list) + control visibility
function renderScarabs(){
  const host = $('scarabs'); if(!host) return;
  const sub = SC.sub==='groups' ? 'groups' : 'top';
  document.querySelectorAll('[data-scsub]').forEach(b=> b.classList.toggle('active', b.dataset.scsub===sub));
  $('scGroupCtrls').classList.toggle('hidden', sub!=='groups');
  if(!SCARABS || !SCARABS.rows || !SCARABS.rows.length){
    host.innerHTML = '<div class="sc-empty">No scarab data for this league yet. Try again shortly, or switch league.</div>';
    $('scCount').textContent = '';
    return;
  }
  if(sub==='top') renderScarabTop(); else renderScarabGroups();
}

// ---------- Top picks (scarab dashboard) ----------
function renderScarabTop(){
  const groups = buildScarabGroups(SCARABS.rows);
  const byMech = {}; groups.forEach(g=> byMech[g.mechanic]=g);
  const rows = SCARABS.rows.map(r=>({ ...r, mechanic:scMechanicOf(r.name), rarity:scRarityOf(r.name) }));
  $('scCount').textContent = `${SCARABS.rows.length} scarabs · ${groups.length} mechanics`;

  // a group card entry: mechanic + its Wtd Avg (click jumps to the group)
  const gEnt = g => ({ jump:g.mechanic, label:g.mechanic, value:fmt(g.weighted), tag:`${g.count} scarab${g.count===1?'':'s'}` });
  // a scarab card entry: icon + name + a value (price or volume), tagged with its mechanic
  const sEnt = (r, valHtml) => ({ jump:r.mechanic, icon:r.image, label:r.name, value:valHtml, tag:r.mechanic });

  const pickGroups = (set, dir) => set.map(m=>byMech[m]).filter(Boolean)
      .sort((a,b)=> dir<0 ? b.weighted-a.weighted : a.weighted-b.weighted).map(gEnt);
  const topRows = (key, valHtml, n=10) => rows.slice().sort((a,b)=> b[key]-a[key]).slice(0,n).map(r=>sEnt(r, valHtml(r)));

  const cards = [
    { title:'Top value scarabs',        sub:'Most expensive single scarabs (raw price)',           entries: topRows('chaos', r=>fmt(r.chaos)) },
    { title:'Best groups to increase',  sub:'Highest Wtd Avg — worth investing Atlas points into',  entries: pickGroups(SC_SET_INCREASE, -1) },
    { title:'Best groups to block',     sub:'Lowest Wtd Avg — least worth your time',               entries: pickGroups(SC_SET_BLOCK, 1) },
    { title:'Best extra-content groups',sub:'Highest Wtd Avg of the map-layer mechanics',           entries: pickGroups(SC_SET_BLOCK, -1) },
  ];

  $('scarabs').innerHTML = '<div class="dash-grid">' + cards.map(c=>{
    const lis = c.entries.length ? c.entries.map(e=>
      `<li data-scjump="${e.jump.replace(/"/g,'&quot;')}" title="Open ${e.jump} in All groups">`+
        `<span class="dn">${e.icon?`<img src="${e.icon}" loading="lazy" alt="">`:''}${e.label}</span>`+
        `<span class="dv">${e.value}<span class="dtag">${e.tag||''}</span></span></li>`).join('')
      : '<li class="dim">no data</li>';
    return `<div class="dash-card"><h3>${c.title}</h3><div class="dash-sub">${c.sub}</div><ol>${lis}</ol></div>`;
  }).join('') + '</div>';
}

// ---------- All groups (full grouped list) ----------
function renderScarabGroups(){
  const host = $('scarabs');
  const qstr = $('scSearch').value.trim().toLowerCase();
  let groups = buildScarabGroups(SCARABS.rows);
  if(qstr) groups = groups.filter(g=> g.mechanic.toLowerCase().includes(qstr) || g.items.some(i=>i.name.toLowerCase().includes(qstr)));

  const hidden  = groups.filter(g=> SC.hidden[g.mechanic]);
  const visible = groups.filter(g=> !SC.hidden[g.mechanic]);
  $('scCount').textContent = `${SCARABS.rows.length} scarabs · ${visible.length}/${groups.length} mechanics`;
  // collapse/expand-all button reflects the current fold state of the visible groups
  const ca = $('scCollapseAll');
  if(ca){ const anyOpen = visible.some(g=> !SC.folds[g.mechanic]);
    ca.textContent = anyOpen ? '⊟ Collapse all' : '⊞ Expand all'; }

  const hiddenBar = hidden.length
    ? `<div class="sc-hiddenbar">Hidden (click to restore): ${hidden.map(g=>
        `<button class="sc-chip" data-scunhide="${g.mechanic}" title="Unhide ${g.mechanic}">${g.mechanic} ✕</button>`).join('')}</div>`
    : '';

  if(!visible.length){ host.innerHTML = hiddenBar + '<div class="sc-empty">No mechanics match — clear the search or restore hidden groups.</div>'; return; }

  host.innerHTML = hiddenBar + visible.map(g=>{
    const open = !SC.folds[g.mechanic];
    const rows = g.items.map(it=>`
      <div class="sc-row">
        <span>${it.image?`<img src="${it.image}" alt="" loading="lazy">`:''}</span>
        <span class="sc-name">${it.name}</span>
        <span>${scRarBadge(it.rarity)}</span>
        <span class="sc-val" title="Raw market price (unweighted)">${fmt(it.chaos)}</span>
        <span class="sc-val sc-dim" title="Weighted: raw × ${scWeightOf(it.rarity)} (${it.rarity} drop weight)">${fmt(it.chaos*scWeightOf(it.rarity))}</span>
        <span class="sc-vol">${fmtVol(it.volume)}</span>
      </div>`).join('');
    return `
      <div class="sc-group ${open?'open':''}">
        <div class="sc-ghead" data-scfold="${g.mechanic}">
          <div class="sc-gname">${open?'▾':'▸'} ${g.mechanic} <small>${g.count} scarab${g.count===1?'':'s'}</small>
            <span class="sc-hide" data-schide="${g.mechanic}" title="Hide this group">✕</span></div>
          ${scMetric('total','Total',g.total)}
          ${scMetric('median','Median',g.median)}
          ${scMetric('average','Raw Avg',g.average)}
          ${scMetric('weighted','Wtd Avg',g.weighted)}
          <div class="sc-metric" title="${SC_METRIC_DESC.volume}"><span class="lbl">Vol</span><b>${fmtVol(g.volume)}</b></div>
        </div>
        <div class="sc-colhdr"><span></span><span>Scarab</span><span>Rar</span>
          <span class="r" title="Raw market price">Raw</span>
          <span class="r" title="Raw × this scarab's rarity drop weight">Wtd</span>
          <span class="r">Vol</span></div>
        <div class="sc-rows">${rows}</div>
      </div>`;
  }).join('');
}

function syncScSort(){
  document.querySelectorAll('[data-scsort]').forEach(b=>{
    const k = b.dataset.scsort, on = SC.sortKey===k;
    b.classList.toggle('active', on);
    b.title = SC_METRIC_DESC[k] + ' (click the active button again to reverse)';
    b.innerHTML = SC_SORT_LABEL[k] + (on ? (SC.sortDir<0 ? ' ▼' : ' ▲') : '');
  });
}
function onScSortClick(e){
  const b = e.target.closest('[data-scsort]'); if(!b) return;
  const k = b.dataset.scsort;
  if(SC.sortKey===k) SC.sortDir = -SC.sortDir; else { SC.sortKey = k; SC.sortDir = -1; }
  saveSC(); syncScSort(); renderScarabs();
}
function onScGroupClick(e){
  const jump   = e.target.closest('[data-scjump]');
  const hide   = e.target.closest('[data-schide]');
  const unhide = e.target.closest('[data-scunhide]');
  const fold   = e.target.closest('[data-scfold]');
  if(jump){   // from a Top-picks entry: open that mechanic in All groups and scroll to it
    const m = jump.dataset.scjump;
    SC.sub='groups'; delete SC.hidden[m]; SC.folds[m]=false; saveSC(); renderScarabs();
    const el = [...document.querySelectorAll('#scarabs [data-scfold]')].find(x=> x.dataset.scfold===m);
    if(el) el.scrollIntoView({behavior:'smooth', block:'center'});
    return;
  }
  if(hide){   e.stopPropagation(); SC.hidden[hide.dataset.schide] = true; saveSC(); renderScarabs(); return; }
  if(unhide){ delete SC.hidden[unhide.dataset.scunhide]; saveSC(); renderScarabs(); return; }
  if(fold){   const m = fold.dataset.scfold; SC.folds[m] = !SC.folds[m]; saveSC(); renderScarabs(); return; }
}
// collapse or expand every visible (non-hidden) group in one click
function onScCollapseAll(){
  if(!SCARABS) return;
  const visible = buildScarabGroups(SCARABS.rows).filter(g=> !SC.hidden[g.mechanic]);
  const anyOpen = visible.some(g=> !SC.folds[g.mechanic]);
  visible.forEach(g=>{ if(anyOpen) SC.folds[g.mechanic]=true; else delete SC.folds[g.mechanic]; });
  saveSC(); renderScarabs();
}
function scResetView(){ SC.sortKey='total'; SC.sortDir=-1; SC.folds={}; SC.hidden={}; saveSC(); syncScSort(); renderScarabs(); }

function buildScarabWeights(){
  const box = $('scWeights'); if(!box) return;
  box.innerHTML = SCARAB_RARITY_LIST.map(r=>
    `<label><span class="sc-wdot" style="background:${SCARAB_RARITY_COLOR[r]}"></span>${r}`+
    `<input type="number" step="0.01" min="0" data-scw="${r}" value="${SC.weights[r]}"></label>`).join('');
  box.querySelectorAll('[data-scw]').forEach(inp=> inp.oninput=()=>{
    const r = inp.dataset.scw, v = parseFloat(inp.value);
    SC.weights[r] = (isNaN(v) || v<0) ? 0 : v; saveSC();
    if(MODE==='scarabs') renderScarabs();
  });
}

// scarab data for a league. Static host (Pages): per-slug file. Local serve.js: slugless file.
async function loadScarabs(slug){
  const urls = slug ? [`json/scarabs-${slug}.json`, 'json/scarabs.json'] : ['json/scarabs.json'];
  for(const u of urls){
    try{ const r = await fetch(u, {cache:'no-store'}); if(r.ok){ SCARABS = await r.json(); return; } }catch{}
  }
  SCARABS = null;
}

// ---------- top-level view (MODE) ----------
function applyMode(){
  const sc = MODE==='scarabs';
  document.querySelectorAll('.mode').forEach(b=> b.classList.toggle('active', b.dataset.mode===MODE));
  document.querySelector('.controls').classList.toggle('hidden', sc);   // gem controls
  document.querySelector('.tabs').classList.toggle('hidden', sc);       // gem tabs
  const foot = document.querySelector('.foot'); if(foot) foot.classList.toggle('hidden', sc);
  $('scarabControls').classList.toggle('hidden', !sc);
  render();
}
// single re-render entry point that respects the active MODE
function render(){
  if(MODE==='scarabs'){
    $('dash').classList.add('hidden');
    document.querySelector('.tablewrap').classList.add('hidden');
    $('scarabs').classList.remove('hidden');
    syncScSort();
    renderScarabs();
  } else {
    $('scarabs').classList.add('hidden');
    renderTable();   // renderTable manages dash vs table itself
  }
}

// ---------- boot ----------
function boot(){
  restoreSettings();
  buildColToggles();
  refreshLinks();

  // events
  $('loadBtn').onclick=()=>{ refreshLinks(); $('loader').classList.remove('hidden'); };
  $('fetchLive').onclick=fetchLive;
  $('applyPaste').onclick=applyPaste;
  document.querySelectorAll('[data-close]').forEach(b=> b.onclick=()=>$(b.dataset.close).classList.add('hidden'));
  // settings modal: gear opens it; click backdrop or Esc closes any modal
  $('settingsBtn').onclick=()=>{ updateTempleLinks(); $('settingsModal').classList.remove('hidden'); };
  document.querySelectorAll('.modal').forEach(m=> m.addEventListener('click', e=>{ if(e.target===m) m.classList.add('hidden'); }));
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') document.querySelectorAll('.modal:not(.hidden)').forEach(m=>m.classList.add('hidden')); });
  // one-time double-corrupt cost prompt
  $('templeSave').onclick=()=>{
    $('dblCost').value = +$('templeInput').value || 0;
    updateDblWarn(); saveSettings(); if(GEMS.length) renderTable();
    localStorage.setItem('gpc_temple_prompted','1'); $('templePrompt').classList.add('hidden');
  };
  const skipTemple=()=>{ localStorage.setItem('gpc_temple_prompted','1'); $('templePrompt').classList.add('hidden'); };
  $('templeSkip').onclick=skipTemple; $('templeSkipX').onclick=skipTemple;
  $('tbl').addEventListener('dblclick', onCellDblClick);
  $('tbl').addEventListener('click', onHeaderClick);
  $('tbl').addEventListener('click', onBlacklistClick);
  $('dash').addEventListener('click', onDashClick);
  $('blkClear').onclick = ()=>{ BLACKLIST={}; save('gpc_blacklist',BLACKLIST); updateBlkCount(); if(GEMS.length) renderTable(); };
  updateBlkCount();
  document.querySelectorAll('.tab').forEach(t=> t.onclick=()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    t.classList.add('active'); CAT=t.dataset.cat; renderTable();
  });
  // top-level Gems ⇄ Scarabs switch
  document.querySelectorAll('.mode').forEach(b=> b.onclick=()=>{
    MODE=b.dataset.mode; save('gpc_mode', MODE); applyMode();
  });
  // scarab controls: sort, reset, fold/hide, search, weights
  buildScarabWeights();
  document.querySelectorAll('[data-scsort]').forEach(b=> b.onclick=onScSortClick);
  document.querySelectorAll('[data-scsub]').forEach(b=> b.onclick=()=>{ SC.sub=b.dataset.scsub; saveSC(); renderScarabs(); });
  $('scReset').onclick = scResetView;
  $('scCollapseAll').onclick = onScCollapseAll;
  $('scarabs').addEventListener('click', onScGroupClick);
  $('scSearch').addEventListener('input', ()=>{
    $('scSearchClear').classList.toggle('hidden', !$('scSearch').value);
    renderScarabs();
  });
  $('scSearchClear').onclick = ()=>{ $('scSearch').value=''; $('scSearchClear').classList.add('hidden'); renderScarabs(); $('scSearch').focus(); };
  $('scWeightReset').onclick = ()=>{ SC.weights=Object.assign({},SC_WEIGHT_DEF); saveSC(); buildScarabWeights(); if(MODE==='scarabs') renderScarabs(); };
  $('settingsBtn2').onclick = ()=>{ updateTempleLinks(); $('settingsModal').classList.remove('hidden'); };
  $('league').addEventListener('change', ()=>{
    refreshLinks(); updateTempleLinks(); saveSettings();
    if(IS_STATIC_HOST) loadStaticData($('league').value);   // static: swap to that league's deployed data
    else if(HAS_API) loadFromServer(true);                  // local server: re-fetch the selected league
  });
  const reRender = ()=>{ if(GEMS.length || MODE==='scarabs') render(); };   // divRate/unit also drive scarab prices
  ASSUME_IDS.forEach(id=> $(id).addEventListener('input', ()=>{ saveSettings(); updateDblWarn(); reRender(); }));
  ['unit','minList','search','confFilter','metaQuality','metaQualityCost','levelQ20'].forEach(id=>
    $(id).addEventListener('input', ()=>{ saveSettings(); reRender(); }));
  // search clear (×)
  $('search').addEventListener('input', syncSearchClear);
  $('searchClear').onclick = ()=>{ $('search').value=''; $('search').dispatchEvent(new Event('input')); $('search').focus(); };
  syncSearchClear();
  // live "prices X old · next update" ticker
  setInterval(updateFreshness, 30000);
  // sort dropdown drives the unified SORT state
  $('sort').addEventListener('change', ()=>{
    SORT.key=$('sort').value; SORT.dir = SORT.key==='name'?1:-1;
    saveSettings(); if(GEMS.length) renderTable();
  });
  // auto-refresh controls
  ['autoRefresh','autoMin'].forEach(id=>
    $(id).addEventListener('input', ()=>{ saveSettings(); setupAutoRefresh(); }));

  // restore sort from saved settings, then sync UI
  SORT.key = $('sort').value || 'vaalEV';
  updateDblWarn();

  // one-time prompt to set the double-corrupt cost (it has no sensible default)
  if((+$('dblCost').value||0)<=0 && !localStorage.getItem('gpc_temple_prompted')){
    $('templeInput').value = $('dblCost').value || '';
    $('templePrompt').classList.remove('hidden');
  }

  applyMode();   // show the saved top-level view (data load re-renders when it arrives)
  initData();
}

// Decide how to load data: local serve.js server, static host (Pages), or local file.
let HAS_API = false;
async function initData(){
  try{ const r=await fetch('json/trademap.json',{cache:'no-store'}); if(r.ok) TRADEMAP=await r.json(); }catch{}
  if(serverMode()) await populateLeagues();   // build the league dropdown + slug map before loading data
  if(serverMode()){
    // http(s): could be the local serve.js helper OR a static host like GitHub Pages.
    // Only the local helper lives on localhost, so probe there (avoids a stray 404 on Pages).
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    HAS_API = false;
    if(isLocal){ try{ HAS_API = (await fetch('/api/status')).ok; }catch{ HAS_API = false; } }
    if(HAS_API){
      // local launcher — offer Refresh + auto-refresh, auto-download on first run
      IS_STATIC_HOST = false;
      $('refreshBtn').classList.remove('hidden');
      $('autoWrap').classList.remove('hidden');
      $('refreshBtn').onclick = () => loadFromServer(true);
      setupAutoRefresh();
      loadFromServer(false);
    } else {
      // static host (e.g. GitHub Pages): data refreshed server-side on a fixed schedule
      IS_STATIC_HOST = true;
      loadStaticData();
    }
  } else {
    // opened as a local file — the manual loader is the only way to get data here
    IS_STATIC_HOST = false;
    $('loadBtn').classList.remove('hidden');
    const cached=load(LS.data,null);
    if(cached?.g){
      try{ ingest(cached.g, cached.c, cached.meta||{league:$('league').value}); }
      catch(e){ setStatus('Cached data unreadable — click Load data manually.','err'); }
    } else {
      $('loader').classList.remove('hidden');
    }
  }
}
document.addEventListener('DOMContentLoaded', boot);
