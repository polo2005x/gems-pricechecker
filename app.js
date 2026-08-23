'use strict';
/* PoE1 Gem Profit Checker
 * Data: poe.ninja economy (SkillGem + Currency overviews).
 * All money math is done in CHAOS, then converted for display. */

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
  };
}
function saveSettings(){
  const s={}; ASSUME_IDS.forEach(id => s[id]=$(id).value);
  ['game','league','unit','sort','minList','showAll','search','autoRefresh','autoMin','metaQuality','metaQualityCost'].forEach(id=>{
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
// exceptional = the boss-drop "exceptional" support gems (poewiki), minus Eclipse
// normal = everything else
const META_RE = /(Empower|Enlighten|Enhance) Support$/;   // matches Awakened variants too
const EXCEPTIONAL = new Set([
  'Cooldown Recovery Support','Frostmage Support','Greater Spell Cascade Support','Voidstorm Support',
  'Foulgrasp Support','Greater Multistrike Support','Hiveborn Support','Hextoad Support','Eclipse Support',
  'Bloodsoaked Banner Support','Invert the Rules Support','Cast on Ward Break Support','Vaal Sacrifice Support',
  'Greater Spell Echo Support','Vaal Temptation Support','Machinations Support','Pyre Support','Bonespire Support',
  'Scornful Herald Support','Cull the Weak Support','Greater Ancestral Call Support','Fissure Support',
  'Hexpass Support','Greater Fork Support','Greater Chain Support','Lethal Dose Support','Companionship Support',
  'Divine Sentinel Support','Annihilation Support','Invention Support','Greater Kinetic Instability Support',
  'Void Shockwave Support','Eldritch Blasphemy Support','Gluttony Support','Overheat Support','Congregation Support',
  'Greater Devour Support','Greater Unleash Support','Pacifism Support','Minion Pact Support','Unholy Trinity Support',
  'Overloaded Intensity Support','Transfusion Support',
]);
function categoryOf(name){
  if(name === 'Eclipse Support' || META_RE.test(name)) return 'meta';
  if(EXCEPTIONAL.has(name)) return 'exceptional';
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
  const out=[];
  for(const g of Object.values(groups)){
    const rows=Object.values(g.map);
    const unc=rows.filter(r=>!r.pv.c);
    if(!unc.length) continue;                    // pure-corrupted (Vaal gems) — can't self-level, skip
    const baseLvl=Math.min(...unc.map(r=>r.pv.lvl));
    const maxLvl =Math.max(...unc.map(r=>r.pv.lvl));
    if(maxLvl<=baseLvl) continue;                // nothing to level
    const at=(lvl,q,c)=>{ const r=g.map[`${lvl}/${q}/${c?1:0}`]; return r?r.chaos:null; };
    // pick the highest uncorrupted quality available at maxLvl (usually 20; awakened exc. may be 0/20)
    const qsAtMax = unc.filter(r=>r.pv.lvl===maxLvl).map(r=>r.pv.q);
    const topQ = Math.max(0,...qsAtMax);         // 20 for normal gems, 0 for exceptional
    const cat=categoryOf(g.name);
    out.push({
      id:l_id(g.name), name:g.name, icon:g.icon,
      baseLvl, maxLvl, topQ, maxList:g.maxList,
      cat, xpEst:xpEstimate(cat, g.name),
      // Prices at both quality tiers (0 and 20). Some gems only trade at one tier
      // (e.g. Empower = 0q only; Eclipse / Greater supports = 20q only) — computeMetrics
      // picks whichever exists so nothing shows blank spuriously.
      raw:{
        buy: at(baseLvl,0,false) ?? at(baseLvl,20,false),  // L1, prefer 0q
        L0:  at(maxLvl,0,false),      // leveled, 0 quality
        L20: at(maxLvl,20,false),     // leveled, 20 quality
        P0:  at(maxLvl+1,0,true),     // corrupted +1 level, 0 quality (the "prize")
        P20: at(maxLvl+1,20,true),    // corrupted +1 level, 20 quality
        F0:  at(maxLvl,0,true),       // corrupted same level, 0q (fail/brick resale)
        F20: at(maxLvl,20,true),      // corrupted same level, 20q
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
    // 20%-quality flip. Show the leveled gem at 0q if it trades there, else 20q.
    leveled = L0 ?? L20; leveledField = L0!=null ? 'L0':'L20';
    prize   = P20 ?? P0; prizeField   = P20!=null ? 'P20':'P0';
    failRaw = F20 ?? F0;
    base = (a.evBase==='leveled')
      ? (L20 ?? (L0!=null ? L0+gq : null))    // buy a leveled 20q gem (or a 0q one + GCP)
      : (buy!=null ? buy+gq : null);          // buy L1 + GCP to 20q
    // pure level flip if a 0q leveled price exists; otherwise the leveled value is 20q → subtract GCP
    m.levelProfit = (leveled!=null && buy!=null)
      ? (L0!=null ? leveled-buy : leveled-buy-gq) : null;
  }
  m.leveled=leveled; m.leveledField=leveledField;
  m.prize=prize; m.prizeField=prizeField;

  const failVal=(proxy, basis)=>{
    if(a.failModel==='zero') return 0;
    if(a.failModel==='buy')  return basis==null ? 0 : basis;
    return proxy!=null ? proxy : 0;               // corrupted same-level price (default)
  };
  m.fail = failVal(failRaw, base);

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
const CAT_LABEL = { normal:'normal', exceptional:'exceptional', meta:'Empower/Enlighten/Enhance/Eclipse' };

function buildCols(mode, showAdj){
  const qa = mode !== 'meta';
  const qtxt = qa ? ', 20% quality' : '';
  const corrupt = qa ? 'Corrupt it (20% quality)' : 'Corrupt it';
  const cols = [
    {name:true, grp:'', label:'Gem'},
    {grp:'Level it yourself', label:'Buy-in', price:'buy', ovr:'buyField', sk:'buy',
      info:'What you pay up front — the level-1 gem (0% quality where it exists).'},
    {grp:'Level it yourself', label:'Leveled', price:'leveled', ovr:'leveledField', sk:'leveled',
      info:'poe.ninja price once leveled to max level. Uses 0% quality when the gem trades there, otherwise the 20% price (many low-level supports only sell at 20q).'},
    {grp:'Level it yourself', label:'Level profit', signed:'levelProfit', sk:'levelProfit',
      info:'Leveled − Buy-in (minus GCP if the leveled price is a 20q one). Profit from leveling it yourself.'},
    {grp:'Level it yourself', label:'Leveling', badge:true, sk:'xp',
      info:'How much XP it takes to level to max, as Fast / Normal / Hard / Brutal (vs a normal L20 gem ≈240M). Exceptional & Empower-tier ≈1.67B to L3 (~7×); Awakened ≈2B. On the Empower-tier tab the badge follows your Leveling-quality bracket. Hover a badge for the gem’s figure and how many times a normal gem it is.'},
    {grp:'Level it yourself', label:'Time-adj. profit', signed:'adjProfit', sk:'adjProfit', when:'adj',
      info:'Level profit ÷ the gem’s grind multiple (XP-to-max vs a normal gem) — profit per unit of leveling time. A gem that takes 7× as long has its leveling profit divided by 7, so slow gems compare fairly against fast ones. Hidden on the Normal tab (normal gems are the 1× baseline, so it equals Level profit). Empower-tier uses your Leveling-quality bracket.'},
    {grp:corrupt, label:'Prize', price:'prize', ovr:'prizeField', sk:'prize', divider:true,
      info:'The jackpot: market price of the corrupted +1-level'+qtxt+' gem.'},
    {grp:corrupt, label:'Fail value', plainMetric:'fail',
      info:'What you keep if the corruption does NOT add a level (same level'+qtxt+', corrupted) — you resell it. Controlled by "Failed-corruption resale".'},
    {grp:corrupt, label:'Vaal EV', ev:['evVaal','winVaal','pV','invVaal','prize'], sk:'vaalEV',
      info:'Average profit per Vaal Orb. The % chance hits the Prize; the rest resell at Fail value. Cost = EV base'+(qa?' + GCP for quality':'')+' + 1 Vaal. Sub-line: hit chance · expected net spend to make one +1 (hover the cell for the full breakdown).'},
    {grp:corrupt, label:'Vaal ÷ time', signed:'adjVaal', sk:'adjVaal', when:'adj',
      info:'Vaal EV ÷ the gem’s leveling grind — corruption profit per unit of leveling time (most accurate when you self-level, EV base = Buy-in). Hidden on the Normal tab (grind 1×, so it equals Vaal EV).'},
    {grp:corrupt, label:'Double EV', ev:['evDbl','winDbl','pD','invDbl','prize'], sk:'dblEV',
      info:'Average profit per Temple double-corrupt — higher hit chance, and its own cost (both editable in Assumptions). Sub-line: hit chance · expected net spend per +1.'},
    {grp:corrupt, label:'Double ÷ time', signed:'adjDbl', sk:'adjDbl', when:'adj',
      info:'Double EV ÷ the gem’s leveling grind — double-corrupt profit per unit of leveling time. Hidden on the Normal tab (grind 1×, so it equals Double EV).'},
    {grp:'', label:'Listings', plainLiq:true, sk:'liquidity',
      info:'poe.ninja listing count — higher = more reliable price, easier to buy & sell.'},
  ];
  return cols.filter(c => c.when!=='adj' || showAdj);
}
function sortValue(g, m, key){
  switch(key){
    case 'buy':         return m.buy;
    case 'leveled':     return m.leveled;
    case 'levelProfit': return m.levelProfit;
    case 'adjProfit':   return m.adjProfit;
    case 'xp':          return g.xpEst;
    case 'prize':       return m.prize;
    case 'vaalEV':      return m.evVaal;
    case 'adjVaal':     return m.adjVaal;
    case 'dblEV':       return m.evDbl;
    case 'adjDbl':      return m.adjDbl;
    case 'liquidity':   return g.maxList;
    case 'name':        return g.name;
    default:            return m.evVaal;
  }
}
const infoIcon = (t)=> `<span class="ci" title="${t.replace(/"/g,'&quot;')}">&#9432;</span>`;
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
  const a=readAssume();
  $('metaControls').classList.toggle('hidden', CAT!=='meta');   // Empower-tier quality controls
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
  const cols = buildCols(mode, CAT!=='normal');   // hide Time-adj. profit on the baseline Normal tab

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

  const showAll=$('showAll').checked;
  const shown = showAll ? rows : rows.slice(0,100);
  $('rowCount').textContent = `${shown.length} of ${rows.length} ${CAT_LABEL[CAT]} gems`;

  // body
  let body='';
  for(const g of shown){
    const m=metricsById[g.id];
    let tds='';
    for(const c of cols){
      const dv = c.divider ? ' divider' : '';
      if(c.name){
        tds+=`<td class="name"><div class="gemname">`+
             (g.icon?`<img src="${g.icon}" loading="lazy" alt="">`:'')+
             `<span title="base L${g.baseLvl} → max L${g.maxLvl}${g.topQ?` / up to ${g.topQ}q`:''}; corrupt target L${g.maxLvl+1}">${g.name}</span>`+
             `</div></td>`;
      } else if(c.badge){
        tds+=`<td class="${dv.trim()}">${xpBadge(g,a)}</td>`;
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
    body+=`<tr>${tds}</tr>`;
  }
  tbl.innerHTML=`<thead>${grpRow}${colRow}</thead><tbody>${body}</tbody>`;
}

// ---------- "Top picks" dashboard ----------
const CAT_TAG = { normal:'Normal', exceptional:'Exceptional', meta:'Empower-tier' };
function renderDashboard(a){
  const minL = +$('minList').value||0;
  const rows = GEMS.filter(g=>g.maxList>=minL)
                   .map(g=>({g, m:computeMetrics(g, a, g.cat==='meta'?'meta':'quality')}));
  const lists = [
    {title:'Best to level — profit',            sub:'Level profit',                       val:x=>x.m.levelProfit},
    {title:'Best to level — profit ÷ time',     sub:'Level profit per unit leveling time',val:x=>x.m.adjProfit},
    {title:'Best single Vaal corrupt',          sub:'Vaal EV / attempt',                  val:x=>x.m.evVaal},
    {title:'Best single Vaal ÷ time',           sub:'Vaal EV per unit leveling time',     val:x=>x.m.adjVaal},
    {title:'Best double corrupt',               sub:'Double EV / attempt',                val:x=>x.m.evDbl},
    {title:'Best double corrupt ÷ time',        sub:'Double EV per unit leveling time',   val:x=>x.m.adjDbl},
    {title:'Biggest +1 prize',                  sub:'Corrupted +1 level value',           val:x=>x.m.prize, plain:true},
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
function onDashClick(e){
  const li=e.target.closest('li[data-cat]'); if(!li) return;
  const cat=li.dataset.cat, name=li.dataset.name;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.cat===cat));
  CAT=cat; $('search').value=name; saveSettings(); renderTable();
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
  renderTable();
  setStatus(`Loaded ${GEMS.length} leveling-viable gems for ${meta.league}` +
            (meta.when?` · cached ${new Date(meta.when).toLocaleString()}`:'') , 'ok');
}
const round2=(v)=>Math.round(v*100)/100;

function setStatus(msg, cls){ const s=$('status'); s.innerHTML=msg; s.className='status'+(cls?' '+cls:''); }

// ---------- URLs ----------
function apiBase(){ return `https://poe.ninja/${$('game').value}/api/economy/stash/current`; }
function gemsUrl(){ return `${apiBase()}/item/overview?league=${encodeURIComponent($('league').value)}&type=SkillGem`; }
function currUrl(){ return `${apiBase()}/currency/overview?league=${encodeURIComponent($('league').value)}&type=Currency`; }
function refreshLinks(){ $('lnkGems').href=gemsUrl(); $('lnkCurr').href=currUrl(); }

async function fetchLive(){
  setStatus('Attempting live fetch…');
  try{
    const [gr,cr]=await Promise.all([fetch(gemsUrl()), fetch(currUrl()).catch(()=>null)]);
    const gj=await gr.json();
    const cj=cr?await cr.json().catch(()=>null):null;
    ingest(gj,cj,{league:$('league').value,game:$('game').value});
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
      const r = await fetch(`/api/refresh?game=${$('game').value}&league=${encodeURIComponent($('league').value)}`);
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
    ingest(gj, cj, {league:$('league').value, game:$('game').value});
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
async function loadStaticData(){
  try{
    const gr = await fetch('json/gems.json', {cache:'no-store'});
    if(!gr.ok) throw new Error('no price data deployed yet');
    const gj = await gr.json();
    let cj = null;
    try{ const cr = await fetch('json/currency.json', {cache:'no-store'}); if(cr.ok) cj = await cr.json(); }catch{}
    let meta = {league:$('league').value, game:$('game').value};
    try{
      const mr = await fetch('json/meta.json', {cache:'no-store'});
      if(mr.ok){ const m = await mr.json(); if(m.league){ meta.league=m.league; $('league').value=m.league; } if(m.game){ meta.game=m.game; $('game').value=m.game; } }
    }catch{}
    ingest(gj, cj, meta);
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
    ingest(gj,cj,{league:$('league').value,game:$('game').value});
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

// ---------- boot ----------
function boot(){
  restoreSettings();
  refreshLinks();

  // events
  $('loadBtn').onclick=()=>{ refreshLinks(); $('loader').classList.remove('hidden'); };
  $('fetchLive').onclick=fetchLive;
  $('applyPaste').onclick=applyPaste;
  document.querySelectorAll('[data-close]').forEach(b=> b.onclick=()=>$(b.dataset.close).classList.add('hidden'));
  document.querySelector('[data-collapse]').onclick=(e)=>{
    const el=$(e.target.dataset.collapse); el.classList.toggle('hidden');
    e.target.textContent = el.classList.contains('hidden')?'Show':'Hide';
  };
  $('tbl').addEventListener('dblclick', onCellDblClick);
  $('tbl').addEventListener('click', onHeaderClick);
  $('dash').addEventListener('click', onDashClick);
  document.querySelectorAll('.tab').forEach(t=> t.onclick=()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    t.classList.add('active'); CAT=t.dataset.cat; renderTable();
  });
  ['game','league'].forEach(id=> $(id).addEventListener('input', ()=>{ refreshLinks(); saveSettings(); }));
  ASSUME_IDS.forEach(id=> $(id).addEventListener('input', ()=>{ saveSettings(); updateDblWarn(); if(GEMS.length) renderTable(); }));
  ['unit','minList','showAll','search','metaQuality','metaQualityCost'].forEach(id=>
    $(id).addEventListener('input', ()=>{ saveSettings(); if(GEMS.length) renderTable(); }));
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

  initData();
}

// Decide how to load data: local serve.js server, static host (Pages), or local file.
async function initData(){
  if(serverMode()){
    // http(s): could be the local serve.js helper OR a static host like GitHub Pages. Probe for the API.
    let hasApi = false;
    try{ hasApi = (await fetch('/api/status')).ok; }catch{ hasApi = false; }
    if(hasApi){
      // local launcher — offer Refresh + auto-refresh, auto-download on first run
      $('refreshBtn').classList.remove('hidden');
      $('autoWrap').classList.remove('hidden');
      $('refreshBtn').onclick = () => loadFromServer(true);
      setupAutoRefresh();
      loadFromServer(false);
    } else {
      // static host: load the deployed json/ data (refreshed server-side by CI); no Refresh button
      loadStaticData();
    }
  } else {
    // opened as a local file — restore cache or show the manual loader
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
