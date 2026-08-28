# PoE1 Profit Checker

A single-page tool that pulls **Path of Exile 1** economy data from [poe.ninja](https://poe.ninja).
Two views, switched with the **Gems ⇄ Scarabs** toggle at the top:

- **Gems** — ranks skill gems by **profit to level** and **profit from corrupting** them.
- **Scarabs** — groups scarabs by **league mechanic** with per-mechanic total / median / average /
  **rarity-weighted** value, so you can see which mechanics are worth the most at a glance.

No install, no build step — it's just `index.html` + `styles.css` + `app.js`.

## 🌐 Live version

**<https://polo2005x.github.io/poe1-profit-checker/>** — open it in any browser, nothing to install.
Prices are auto-refreshed server-side (a GitHub Action re-fetches poe.ninja ~every 15 min, best-effort),
so it just works and stays reasonably current. The **League** dropdown switches between all
economy leagues (softcore, hardcore, Standard, …) — each is fetched and deployed (gems **and** scarabs),
so switching loads that league's data instantly. For on-demand fresh prices, run it locally with `start.bat`.

## How to run it (recommended — fully automatic)

**Double-click `start.bat`.**

That's it. It starts a tiny local helper that downloads the latest poe.ninja prices,
saves them to `json/`, and opens the tool in your browser already loaded. A black
console window stays open while you use it — just close it when you're done.

- Requires **Node.js** (already installed if `node -v` works in a terminal; otherwise
  get it free at <https://nodejs.org>). No other setup, no `npm install`.
- Click **↻ Refresh prices** in the page anytime to re-download the latest data.
- Change the **League** / **Game** dropdown, then Refresh, to pull a different league
  (default is the current PoE1 challenge league, **Allflame**).

### Why the launcher?

A web page opened straight from disk is sandboxed by the browser — it can't download
files or reach poe.ninja directly (the "CORS" block). The little Node helper does the
download for you (servers have no such restriction) and hands the page the data. That's
the only way to make refreshing one-click.

## Manual mode (no Node / offline)

You can also just **double-click `index.html`**. It works, but you feed it data by hand:

1. Click **Load data manually**.
2. Click **↗ Open Skill Gems JSON** — a page of raw text opens. Save it (Ctrl-S).
3. (Optional) same for **↗ Open Currency JSON** (live GCP / Vaal / Divine prices).
4. Pick the saved file(s) with the file picker, then **Use pasted / loaded JSON**.

The data is then **cached in your browser**, so it reloads instantly next time. Repeat
when you want fresh prices. (Use the file picker, not paste — the gem data is ~4 MB.)

Either way, your settings and manual price overrides are saved in your browser.

## What the columns mean

Everything is priced in **Chaos** (switch to Divine with the Currency dropdown).

**Cost model** (your clarified baseline): you *buy a level 1 / 0-quality gem*, *level it
to max yourself* (free), and use *Gemcutter's Prisms* for quality.

Every header has a **ⓘ** — hover it for the plain-English meaning. Click a header to sort by it.
Every price cell has a small **↗** — click it to open that exact gem/level/quality on the official
**pathofexile.com/trade** with the search prefilled (handy for double-corrupt 21/23 prices poe.ninja
prices thinly). Open **⚙ Settings** to tweak assumptions, filter by min-listings, and **show/hide columns**.

| Column | Meaning |
|---|---|
| **Buy-in** | Price of the level 1 / 0q gem you start with. |
| **Leveled** | Sell price at max level, 0 quality ("–" = no 0q market). |
| **Level profit** | Leveled − Buy-in. Pure profit from leveling it yourself. |
| **Time-adj. profit** | **Level profit ÷ the gem's grind multiple** (its XP-to-max vs a normal gem) — profit *per unit of leveling time*. One that takes 7× as long has its profit divided by 7, so slow gems compare fairly against fast ones. *Hidden on the Normal tab* (normal gems are the 1× baseline, so it just equals Level profit). Empower-tier follows the Leveling-quality bracket. |
| **Leveling** | How much XP it takes to reach max level — a **Fast / Normal / Hard / Brutal** badge, judged against a normal L20 gem (~240M). Exceptional & Empower/Enlighten/Enhance/Eclipse ≈1.67B to level 3 (~7× — they share one XP curve); Awakened ≈2B. Hover for the gem's figure **and how many times a normal gem it is**. (Tier is inferred from category / max level in the data.) |
| **Prize** | Market price of the corrupted **+1 level** gem (21/20 on the normal & exceptional tabs; +1 level / 0q on the meta tab). The jackpot you're gambling for. |
| **Fail value** | What you keep if the corruption doesn't add a level — the same-level corrupted gem, resold. Set by *Failed-corruption resale*. |
| **Vaal EV** | Average profit *per Vaal Orb* — already nets out reselling the failures. Sub-line: **hit chance · expected net investment to make one +1** (≈`1/p` attempts × cost, minus the resale of the bricks). Hover the cell for the full breakdown (attempts, invest, profit/+1, profit-if-it-hits). |
| **Double EV** | Same, for a Temple double-corruption (higher odds + its own cost). Same sub-line and hover breakdown. |
| **Vaal ÷ time** / **Double ÷ time** | The corruption EVs divided by the gem's leveling grind — corruption profit *per unit of leveling time* (most accurate when you self-level). Separate from the raw EV columns, which are unchanged. Hidden on the Normal tab (grind 1× = identical to the raw EV). |
| **Listings** | poe.ninja listing count — liquidity / reliability gauge. |

"max level" is 20 for standard gems (so +1 = level 21). A few gem types cap lower
(Awakened = 5, exceptional supports = 3); the tool detects this per gem — hover a gem's
name to see its exact range.

### The tabs

- **★ Top picks** — the default landing tab. A dashboard of top-10 lists across all gems: best to level (raw profit and profit ÷ leveling time), best single-Vaal and double-corrupt EV (raw and ÷ leveling time), and biggest +1 prize. The **÷ time** lists divide by the gem's grind multiple, so they favour fast-leveling gems that are efficient per unit of leveling time (most useful when you self-level — EV base = Buy-in). Click any gem to jump to its tab, filtered to it.
- **Normal** — everything that levels normally (1 → 20 for most gems). Full corrupt-at-20q columns.
- **Exceptional** — the boss-drop "exceptional" support gems (per the [PoE Wiki list](https://www.poewiki.net/wiki/Exceptional)) — Cast on Ward Break, the *Greater ___* supports, Vaal Temptation, etc. They level low (max 3) but still have quality, so they keep the 20q columns.
- **Empower / Enlighten / Enhance / Eclipse** — the meta supports you level purely for the level bonus. **Quality doesn't matter** for the corrupt, so this tab shows the 0-quality corruption (no GCP cost). Two extra controls appear on this tab:
  - **Leveling quality** (10 / 20 / 30 / 38 / 50 / 60%) — quality on these gems gives *5% increased experience per 1% quality*, so it speeds leveling. Pick the setup you'll use (hover for what each bracket needs — matching socket colour, GCP, Atziri's Disfavour, etc.) and the **Leveling** badge follows it: 10% ≈ Brutal (4.6× a normal gem), 20% ≈ Hard (3.5×), 60% ≈ Normal (1.7×).
  - **charge 20% quality (GCP)** — adds the 20-GCP cost of quality-ing the gem to your leveling and corruption cost.

Gems that only exist corrupted (Vaal skill gems) are excluded — you can't "level them yourself."

## Scarabs

Flip the top toggle to **Scarabs** for a second view built for scarab valuation. Every scarab from
poe.ninja's bulk-exchange data is bucketed by its **league mechanic** (Legion, Delirium, Betrayal, …),
and each mechanic group shows four metrics you can sort by:

| Metric | Meaning |
|---|---|
| **Total** | Sum of one of each scarab in the mechanic — ranks mechanics by combined value. |
| **Median** | The middle scarab price, ignoring a single very expensive outlier — the typical scarab's worth. |
| **Raw Avg** | Plain (unweighted) mean of every scarab price. No rarity weighting. |
| **Wtd Avg** | **Rarity-weighted** expected value of a *random* drop — rarer scarabs count less, because you see them less. The realistic "what's a drop from this mechanic worth" number. |

Each scarab row shows its **rarity** (Common → Extreme, from poedb.tw — a fixed game property), its **Raw**
price, its **Wtd** price (raw × that rarity's drop weight), and recent trade **Volume**. Fold a group by
clicking its header, hide one with the **✕** (restore it from the bar that appears), and search by scarab or
mechanic name. Prices honour the same **Currency** (Chaos / Divine) toggle as the Gems view.

The per-rarity **drop weights** are editable in **⚙ Settings → Scarab rarity drop weights** (defaults are
calibrated from a 3.27 drop sample); lowering a rarity's weight makes it count for less in every group's
**Wtd Avg**, and the view re-scores instantly. Sort, folds, hidden groups, and weights are all saved in your browser.

**Allflames** (Necropolis allflame embers) get their own group at the bottom of **All groups**, plus a
**Best allflames** card in the scarab Top picks. Because they aren't Atlas-targetable, there's no rarity
weighting or Wtd Avg for them — the group shows just **raw price + volume** per ember and a **Total + Vol**
header. They're kept out of the gem Top picks entirely.

### Corruption odds (why EV can be negative)

A single Vaal Orb has a **~12.5%** chance to add +1 level (25% chance it changes level,
half of those are +1). So on expensive gems the *jackpot* (profit-when-it-hits) is huge
but the *EV per attempt* can be negative — you brick most of them. Cheap gems with a big
Prize are where the reliable profit is.

All odds and costs are **editable** in the *Assumptions* panel and everything recalculates
live:
- **EV cost base** — whether the corruption EV assumes you *level a level-1 gem yourself*
  (Buy-in) or *buy an already-leveled gem* (Leveled). Buying leveled costs more, so the EV is lower/more conservative.
- **Double-corrupt cost** — a real double corrupt is never free; the field is **flagged red at 0** because leaving it there makes Double EV look too good.
- Defaults: Vaal +1 = 12.5%, Double +1 = 25% (an estimate — tune it), failed-corruption
  resale = the corrupted same-level price from the data.

## Manual price override

Double-click **any price cell** (Buy-in, Leveled, Prize) to type your own value (e.g. a
real trade price). It's marked with a ✎ and used everywhere in that row's math. Clear the
box to go back to the poe.ninja price. Overrides are saved per gem.

## Auto-refresh

In launcher mode, tick **auto every N min** (next to Refresh) to have the tool re-download
prices on that interval automatically. (Manual mode can't fetch, so this only appears when
running via `start.bat`.)
