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

(async () => {
  // index-state gives the current league + the full league list (for the dropdown)
  const idx = await getJson(`https://poe.ninja/${game}/api/data/index-state`);
  const eco = idx.economyLeagues || [];
  const leagueNames = eco.map(l => l.name).filter(Boolean);
  // current softcore challenge league = first that isn't Standard / any Hardcore
  const league = process.env.LEAGUE || (eco.find(l => !/standard|hardcore/i.test(l.name)) || eco[0] || {}).name;
  if(!league) throw new Error('could not determine current league');
  const base = `https://poe.ninja/${game}/api/economy/stash/current`;

  const gems = await getJson(`${base}/item/overview?league=${encodeURIComponent(league)}&type=SkillGem`);
  if(!gems.lines || !gems.lines.length) throw new Error(`no gems returned for league "${league}"`);

  let currency = null;
  try { currency = await getJson(`${base}/currency/overview?league=${encodeURIComponent(league)}&type=Currency`); }
  catch(e){ console.warn('currency fetch failed (optional):', e.message); }

  fs.mkdirSync(outDir, { recursive: true });

  // slim to only the fields the app reads — keeps the deployed artifact small
  const slimGems = { lines: gems.lines.map(l => ({
    name:l.name, icon:l.icon, variant:l.variant, chaosValue:l.chaosValue, listingCount:l.listingCount,
  })) };
  fs.writeFileSync(path.join(outDir, 'gems.json'), JSON.stringify(slimGems));

  if(currency && currency.lines){
    const slimCurr = { lines: currency.lines.map(l => ({
      currencyTypeName:l.currencyTypeName, chaosEquivalent:l.chaosEquivalent,
    })) };
    fs.writeFileSync(path.join(outDir, 'currency.json'), JSON.stringify(slimCurr));
  }
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ league, game, when: Date.now() }));
  if(leagueNames.length) fs.writeFileSync(path.join(outDir, 'leagues.json'), JSON.stringify(leagueNames));

  // gem display-name -> trade type/discriminator, for building pathofexile.com/trade links
  try {
    const items = await getJson('https://www.pathofexile.com/api/trade/data/items');
    const gemEntries = [].concat(...(items.result || []).filter(c => /gem/i.test(c.id)).map(c => c.entries || []));
    const map = {};
    for(const e of gemEntries){ const name = e.text || e.type; if(name) map[name] = e.disc ? {t:e.type, d:e.disc} : {t:e.type}; }
    fs.writeFileSync(path.join(outDir, 'trademap.json'), JSON.stringify(map));
    console.log(`wrote trademap (${Object.keys(map).length} gem types)`);
  } catch(e){ console.warn('trademap fetch failed (optional):', e.message); }

  console.log(`wrote ${slimGems.lines.length} gems for ${league} (${game}) to ${outDir}`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
