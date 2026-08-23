'use strict';
/* Tiny local helper for PoE1 Gem Profit Checker.
 * Node has no CORS restriction, so it can download poe.ninja data server-side,
 * save it to ./json/, and serve the page. Zero dependencies (Node 18+ built-ins).
 * Run with:  node serve.js   (or double-click start.bat) */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORT = +(process.env.PORT || 8123);
const MT = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
             '.json':'application/json', '.png':'image/png', '.ico':'image/x-icon',
             '.svg':'image/svg+xml', '.map':'application/json' };

function apiUrls(game, league){
  const b = `https://poe.ninja/${game}/api/economy/stash/current`;
  const L = encodeURIComponent(league);
  return {
    gems: `${b}/item/overview?league=${L}&type=SkillGem`,
    curr: `${b}/currency/overview?league=${L}&type=Currency`,
  };
}

// download both overviews and write them to ./json/
async function refresh(game, league){
  const { gems, curr } = apiUrls(game, league);
  const gr = await fetch(gems);
  if(!gr.ok) throw new Error(`poe.ninja gems HTTP ${gr.status} (check league name "${league}" / game "${game}")`);
  const gText = await gr.text();
  // validate BEFORE writing — poe.ninja returns 200 + {"lines":[]} for an unknown league,
  // so guard against silently overwriting good data with an empty result.
  let gCount = -1;
  try { const j = JSON.parse(gText); gCount = Array.isArray(j.lines) ? j.lines.length : -1; } catch {}
  if(gCount <= 0) throw new Error(`no gems returned for league "${league}" (${game}) — check the spelling/game`);

  let cText = null;
  try {
    const cr = await fetch(curr);
    if(cr.ok){ const t = await cr.text(); const cj = JSON.parse(t); if(Array.isArray(cj.lines) && cj.lines.length) cText = t; }
  } catch { /* currency optional */ }

  fs.mkdirSync(path.join(ROOT, 'json'), { recursive:true });
  fs.writeFileSync(path.join(ROOT, 'json', 'gems.json'), gText);
  if(cText) fs.writeFileSync(path.join(ROOT, 'json', 'currency.json'), cText);
  console.log(`  ↻ downloaded ${league} (${game}) — ${(gText.length/1e6).toFixed(1)} MB gems` +
              (cText ? ' + currency' : '') + ` @ ${new Date().toLocaleTimeString()}`);
  return { ok:true, when:Date.now(), gemsBytes:gText.length, hasCurrency:!!cText, league, game };
}

function sendJson(res, code, obj){
  res.writeHead(code, { 'content-type':'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if(url.pathname === '/api/refresh'){
    const game   = url.searchParams.get('game')   || 'poe1';
    const league = url.searchParams.get('league') || 'Allflame';
    try { sendJson(res, 200, await refresh(game, league)); }
    catch(e){ console.error('  ✗ refresh failed:', e.message); sendJson(res, 502, { ok:false, error:e.message }); }
    return;
  }
  if(url.pathname === '/api/status'){
    try { const st = fs.statSync(path.join(ROOT, 'json', 'gems.json'));
          sendJson(res, 200, { exists:true, when:st.mtimeMs, bytes:st.size }); }
    catch { sendJson(res, 200, { exists:false }); }
    return;
  }

  // static files
  let p = decodeURIComponent(url.pathname);
  if(p === '/') p = '/index.html';
  const fp = path.normalize(path.join(ROOT, p));
  if(!fp.startsWith(ROOT)){ res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (e, data) => {
    if(e){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MT[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', (e) => {
  if(e.code === 'EADDRINUSE'){
    console.error(`\n  Port ${PORT} is busy — the tool may already be running.`);
    console.error(`  Open  http://localhost:${PORT}/  in your browser.\n`);
  } else console.error(e.message);
});

server.listen(PORT, () => {
  const link = `http://localhost:${PORT}/`;
  console.log('\n  PoE1 Gem Profit Checker');
  console.log('  Running at ' + link);
  console.log('  Keep this window open. Close it to stop.\n');
  if(!process.env.NO_OPEN) exec(`start "" "${link}"`, () => {});   // open default browser (Windows)
});
