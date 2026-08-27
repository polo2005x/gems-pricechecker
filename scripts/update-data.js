'use strict';
/* Fetches poe.ninja economy data server-side (no CORS on a CI runner) and writes
 * slimmed JSON for the static site. Used by the GitHub Pages deploy workflow.
 * Usage: node scripts/update-data.js [outDir] [game]
 *   outDir defaults to ./json ; game defaults to poe1.
 *   Override the league with the LEAGUE env var; otherwise the current challenge
 *   league is auto-detected, so this keeps working when leagues change. */

const fs = require('fs');
const path = require('path');

const outDir = process.argv[2] || path.join(__dirname, '..', 'json');
const game   = process.argv[3] || 'poe1';

async function getJson(url){
  const r = await fetch(url, { headers: { 'user-agent': 'poe1-profit-checker-bot' } });
  if(!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

const slim = (lines, keys) => ({ lines: lines.map(l => Object.fromEntries(keys.map(k => [k, l[k]]))) });

(async () => {
  // index-state gives every economy league (softcore, hardcore, standard, …)
  const idx = await getJson(`https://poe.ninja/${game}/api/data/index-state`);
  const eco = idx.economyLeagues || [];
  const defaultLeague = process.env.LEAGUE || (eco.find(l => !/standard|hardcore/i.test(l.name)) || eco[0] || {}).name;
  const defaultSlug   = (eco.find(l => l.name === defaultLeague) || {}).url || (eco[0] || {}).url;
  if(!defaultLeague) throw new Error('could not determine leagues');
  const base = `https://poe.ninja/${game}/api/economy/stash/current`;
  const exch = `https://poe.ninja/${game}/api/economy/exchange/current`;   // scarabs live on the bulk-exchange API
  const IMG_HOST = 'https://web.poecdn.com';                               // scarab icons are on the CDN, not poe.ninja
  fs.mkdirSync(outDir, { recursive: true });

  // fetch each league so the dropdown can switch between them client-side on the static site
  const withData = [];
  for(const l of eco){
    try {
      const gems = await getJson(`${base}/item/overview?league=${encodeURIComponent(l.name)}&type=SkillGem`);
      if(!gems.lines || !gems.lines.length){ console.warn(`  ${l.name}: no gems, skipped`); continue; }
      fs.writeFileSync(path.join(outDir, `gems-${l.url}.json`),
        JSON.stringify(slim(gems.lines, ['name','icon','variant','chaosValue','listingCount'])));
      try {
        const cur = await getJson(`${base}/currency/overview?league=${encodeURIComponent(l.name)}&type=Currency`);
        if(cur.lines) fs.writeFileSync(path.join(outDir, `currency-${l.url}.json`),
          JSON.stringify(slim(cur.lines, ['currencyTypeName','chaosEquivalent'])));
      } catch { /* currency optional */ }
      // scarabs: bulk-exchange overview, joined with item meta for name/image. The app groups
      // them by mechanic & applies rarity weights client-side, so we only ship the raw prices.
      let scCount = 0;
      try {
        const sc = await getJson(`${exch}/overview?league=${encodeURIComponent(l.name)}&type=Scarab`);
        const meta = {}; (sc.items || []).forEach(it => meta[it.id] = it);
        const divineRate = (sc.core && sc.core.rates && sc.core.rates.divine) || 0;
        const rows = (sc.lines || []).map(ln => {
          const it = meta[ln.id] || {};
          return { id: ln.id, name: it.name || ln.id,
                   image: it.image ? IMG_HOST + it.image : null,
                   chaos: ln.primaryValue || 0, volume: ln.volumePrimaryValue || 0 };
        }).filter(r => r.chaos > 0);
        if(rows.length){
          fs.writeFileSync(path.join(outDir, `scarabs-${l.url}.json`), JSON.stringify({ divineRate, rows }));
          scCount = rows.length;
        }
      } catch { /* scarabs optional */ }
      withData.push({ name:l.name, slug:l.url });
      console.log(`  ${l.name}: ${gems.lines.length} gems${scCount ? `, ${scCount} scarabs` : ''}`);
    } catch(e){ console.warn(`  ${l.name}: failed — ${e.message}`); }
  }
  if(!withData.length) throw new Error('no league data fetched');

  fs.writeFileSync(path.join(outDir, 'leagues.json'), JSON.stringify(withData));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ defaultLeague, defaultSlug, game, when: Date.now() }));

  // gem display-name -> trade type/discriminator (league-independent), for pathofexile.com/trade links
  try {
    const items = await getJson('https://www.pathofexile.com/api/trade/data/items');
    const gemEntries = [].concat(...(items.result || []).filter(c => /gem/i.test(c.id)).map(c => c.entries || []));
    const map = {};
    for(const e of gemEntries){ const name = e.text || e.type; if(name) map[name] = e.disc ? {t:e.type, d:e.disc} : {t:e.type}; }
    fs.writeFileSync(path.join(outDir, 'trademap.json'), JSON.stringify(map));
    console.log(`wrote trademap (${Object.keys(map).length} gem types)`);
  } catch(e){ console.warn('trademap fetch failed (optional):', e.message); }

  console.log(`done — ${withData.length} leagues, default ${defaultLeague}`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
