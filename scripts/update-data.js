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
  const r = await fetch(url, { headers: { 'user-agent': 'gems-pricechecker-bot' } });
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
      withData.push({ name:l.name, slug:l.url });
      console.log(`  ${l.name}: ${gems.lines.length} gems`);
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
