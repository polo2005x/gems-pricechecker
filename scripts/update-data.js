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

async function currentLeague(){
  const idx = await getJson(`https://poe.ninja/${game}/api/data/index-state`);
  const leagues = idx.economyLeagues || [];
  // the current softcore challenge league = first that isn't Standard / any Hardcore
  const pick = leagues.find(l => !/standard|hardcore/i.test(l.name)) || leagues[0];
  if(!pick) throw new Error('could not determine current league');
  return pick.name;
}

(async () => {
  const league = process.env.LEAGUE || await currentLeague();
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

  console.log(`wrote ${slimGems.lines.length} gems for ${league} (${game}) to ${outDir}`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
