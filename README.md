# Regime // Rotation Terminal

A Bloomberg-terminal-styled market regime score (SPY/QQQ/IWM) and sector
rotation ranking, backed by Supabase and deployable to Vercel. Real Next.js
project — runs on `localhost`, no sandbox.

Renders with a bundled **demo dataset** (the last real backtest run) until you
connect Supabase, so `npm run dev` shows a working terminal immediately. A
yellow `DEMO DATA` badge in the header tells you which mode you're in; it
switches to a green `LIVE — SUPABASE` badge once real tables are wired up.

## 1. Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 — you'll see the terminal running on the bundled
demo data.

## 2. Connect Supabase

1. Create a project at supabase.com (or use one you already have).
2. In the SQL editor, run `supabase/schema.sql` — it creates the tables
   (`raw_prices`, `symbol_meta`, `regime_snapshot`, `regime_history`,
   `sector_rankings`, `rotation_strength`, `trade_setups`, `backtest_curves`,
   `backtest_stats`, `refresh_log`) plus the `latest_prices` view, turns on
   Row Level Security with a public-read-only policy, adds the live tables to
   the Realtime publication so the terminal updates with no polling, and
   registers the `pg_cron` jobs.
3. Copy `.env.local.example` to `.env.local` and fill in your project's URL
   and anon key (Project Settings → API).
4. Restart `npm run dev` — the badge should flip to `LIVE — SUPABASE` once
   the tables have at least one row (see the refresh job below).

The anon key is safe to ship to the browser: RLS only grants it `SELECT`.
Nothing in the deployed site can write to your database.

## 3. Populate it — the refresh pipeline

**The math runs entirely inside Supabase now**, as four Edge Functions in
`supabase/functions/` (TypeScript/Deno ports of the original Python
formulas), triggered on a schedule by Postgres itself (`pg_cron` + `pg_net`
— see the bottom of `supabase/schema.sql`). Nothing needs to stay open —
not a terminal, not this chat, not any external process — for the site to
keep refreshing during market hours.

| Function | Reads | Writes | Trigger |
|---|---|---|---|
| `ingest-prices` | request body | `raw_prices` | called by the scheduled ingest task (below) |
| `compute-regime-score` | `raw_prices` | `regime_snapshot`, `regime_history` | `pg_cron`, hourly (market hours) |
| `compute-sector-rotation` | `raw_prices` | `sector_rankings` | `pg_cron`, hourly (market hours) |
| `compute-trade-setups` | `raw_prices`, `symbol_meta` | `rotation_strength`, `trade_setups` | `pg_cron`, hourly (market hours) |

All four write with the **service role key** (`SUPABASE_SERVICE_ROLE_KEY`,
auto-injected into every Edge Function's environment by Supabase — never
exposed to the browser) and authenticate write requests with a shared-secret
header (`x-refresh-secret`) instead of a Supabase JWT, since the caller is
an automated job, not a logged-in user. Deploy them with the Supabase CLI or
dashboard:

```bash
supabase functions deploy ingest-prices
supabase functions deploy compute-regime-score
supabase functions deploy compute-sector-rotation
supabase functions deploy compute-trade-setups
```

**The one piece that still needs an external actor: getting Robinhood data
in.** `raw_prices` (fresh daily bars for every symbol in `symbol_meta` — the
19 ETFs plus the ~66 stocks tracked inside the sectors) is the only input
these functions can't produce themselves — Edge Functions can't authenticate
to a personal Robinhood session. In this deployment that gap is filled by a
scheduled Claude task (a "Routine") that wakes up hourly during market hours,
reads the symbol list out of `symbol_meta`, pulls fresh OHLCV bars via the
Robinhood MCP connector, and calls `ingest-prices` with them. It skips bars
flagged `interpolated` (synthetic gap-fill for the not-yet-complete session),
which would otherwise write flat fake bars and corrupt ATR. That task does **no computation** — it's a thin
data-delivery step; every actual formula lives in the Edge Functions above.
If you'd rather not depend on a scheduled Claude task at all, point any
process you control (a small cron job, a Polygon/Alpaca/IEX-backed script,
etc.) at the same `ingest-prices` endpoint with the same request shape:

```
POST https://<project-ref>.supabase.co/functions/v1/ingest-prices
Content-Type: application/json
x-refresh-secret: <your REFRESH_SECRET>

{"prices": [{"symbol":"SPY","date":"2026-09-16","open":761.2,"high":766.4,"low":759.8,"close":765.96,"volume":58231044}, ...]}

`close` is required; `open`/`high`/`low`/`volume` are optional, but send high
and low when you have them — true range (and therefore every stop and target)
degrades to a close-only proxy without them.
```

### A note on outbound HTTPS from a sandboxed caller

If the process calling `ingest-prices` runs in a network-sandboxed
environment (as the scheduled Claude task does), a direct HTTPS request to
`*.supabase.co` may be firewalled off entirely. The fix used here: don't call
the Edge Function's HTTPS URL directly — instead run `select net.http_post(...)`
through the **Supabase SQL/MCP connection itself**, so Postgres's own server
(which has unrestricted egress) makes the HTTP call on the caller's behalf.
This is also exactly how the `pg_cron` jobs invoke the three compute
functions — see `supabase/schema.sql` for the exact
`net.http_post(...)` calls both paths use.

### Refresh cadence — set expectations honestly

The regime score and sector ranking are built from **daily** OHLCV bars — the
underlying signal doesn't actually change intraday. Refreshing every trading
hour (rather than every second) already refreshes faster than the model's
real signal cadence; treat "live" here as "caught up with each new daily
close and intraday RTH session," not a tick-by-tick quote feed. If you want
a genuinely real-time quote strip on top of this, wire a separate live-quote
API into the ticker bar (`components/Ticker.tsx`) — that's a different,
much higher-frequency data need than what drives the regime/rotation math.

### `scripts/refresh.py` — reference implementation, not part of the live path

The original Python implementation is kept in `scripts/refresh.py` purely as
the clearest reference for the exact formulas (it's what the Edge Functions
were ported from line-for-line). It's no longer what runs in production —
you don't need to run it, and nothing schedules it — but if you're auditing
the math or prefer pandas to TypeScript, start there.

## 4. Deploy to Vercel

```bash
npm i -g vercel   # if you don't have it
vercel
```

Add the two `NEXT_PUBLIC_*` env vars from `.env.local` in the Vercel project
settings (Settings → Environment Variables) before or after the first
deploy — `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. The
service role key never goes to Vercel — it's only used by the refresh job,
which runs elsewhere (see above).

## What the terminal shows

The UI is laid out like a desktop trading workstation: a menu bar with a
green accent stripe, a dense three-column grid of titled "windows"
(`components/Panel.tsx`), and a scrolling ticker strip pinned to the bottom.
It collapses to one column on phones.

| Window | Column | What's in it |
|---|---|---|
| **Pipeline** | left | News-feed style log of every automated run from `refresh_log` (ingest + both compute jobs), newest first, with ok/failed dots |
| **SPY / QQQ / IWM** quote cards | left | Last close + day change, 52-wk hi/lo and range position (from the `latest_prices` view), the composite regime z-score and bucket, and a 60-session sparkline |
| **.REGIME SPY** / **.REGIME SPY-QQQ-IWM** | middle | Composite regime charts with 3M/6M/1Y/3Y/5Y/MAX range buttons, bucket threshold lines, drawdown-event shading, hover readout |
| **Sector Momentum** | middle | Ranked bar chart of the risk-adjusted momentum score per sector |
| **Backtest** | middle | Growth-of-$1 curves for the four strategies + CAGR / vol / Sharpe / max-DD table |
| **Tracked Instruments** | middle | Positions-style table of the 19 ETFs: role, fund name, what the math uses it for, last, change, 52-wk range, momentum rank/score/3-6-12M returns, last update |
| **Regime Composite — Legs** | right | Multi-leg "ticket": the five weighted legs (trend, breadth, vol, credit, curve), what each reads, its weight, and its current z-score for every index side by side, plus the composite and bucket |
| **Sector Rotation Ladder** | right | Option-chain style ladder of the 11 sectors: 3/6/12M returns, highlighted ticker column, score bar, rank; top-3 holdings shaded |
| **Alerts** | right | Derived at render time: regime bucket state per index, bucket flips in the last 5 sessions, failed pipeline runs, stale-data warnings, current top-3 holdings |
| **Rotation Plays** | middle | The candidate long list: leading sector ETFs plus the strongest names inside them, with strength, buy-below, reference entry, stop, risk %, T1/T2, a stop→target ladder, ATR-to-target feasibility, and shares per $1,000 of risk |
| **Rotation Strength** | right | 0-100 reading of how tradeable the current rotation is, its three components, current leaders/laggards, and a 250-session history |
| **Message Center** | right | Data mode, as-of date, symbols reporting, last run of each pipeline stage, and a live countdown to the next `pg_cron` compute |

Everything is wired to Supabase Realtime via `RealtimeRefresher` — any row
written to `raw_prices`, `regime_snapshot`, `regime_history`,
`sector_rankings`, or `refresh_log` triggers every open tab to refresh
immediately, no polling. The `RT` badge in the menu bar shows the
subscription state, how many change events have arrived, and when the last
one landed.

### Units, so nothing gets misread

- Regime score and its five legs are **z-scores** (unitless, typically −3…+3).
- Sector `r3` / `r6` / `r12` are stored as **percent** (`12.9` = +12.9%), the
  same convention as `scripts/refresh.py`.
- Sector `score` is unitless (blended momentum ÷ annualized vol).
- `latest_prices.chg_pct` is percent; `chg` is in price units.

## The play list, and what the numbers mean

`compute-trade-setups` answers two separate questions.

**Is this rotation worth trading?** Three things have to be true at once for a
sector rotation to be tradeable, so `rotation_strength` measures all three and
blends them into a 0-100 score:

- **Dispersion** — the cross-sectional standard deviation of the 11 sector
  scores. If every sector is moving together there is nothing to rotate into,
  however strong the market is.
- **Leader gap** — mean of the top 3 scores minus mean of the bottom 3. How
  much you actually gain by being in the leaders rather than the field.
- **Persistence** — Spearman rank correlation between today's sector ranking
  and the ranking 21 sessions ago. Leadership that reshuffles every week is
  not something you can hold a position through.

Each is scored against its own trailing year and blended 40/35/25. The
important case is the one a single number would hide: **wide dispersion with
low persistence is labelled `churn`, not `strong`** — sectors are spread out
but the leadership keeps changing, which is the worst backdrop to enter into.

**What do I actually buy, and where are my levels?** Candidates are the top-3
momentum sectors, plus the strongest individual names inside each of those
sectors (`symbol_meta` maps stocks to their SPDR sector). Sector ETFs are
scored on the same 3/6/12-month blend as the ladder; individual names use a
faster 3/6-month blend, because inside an already-chosen sector what matters
is who is leading now.

Levels are arithmetic, not opinion:

- **Stop** — 2 ATR below the close, dropped under the 20-day low when structure
  sits lower, then capped at 3 ATR. The cap matters: without it a deep recent
  low drags the stop so wide that the trade risks more than the first target
  pays.
- **Targets** — fixed multiples of that risk, T1 at 2R and T2 at 3R. That makes
  the reward:risk constant by construction, which is the point: the plan always
  has the same shape and you size to it.
- **ATR→T1** — how many *daily* ATRs the price has to cover to reach T1. This is
  the honest feasibility check that a fixed R multiple hides. Four to six is
  normal for a multi-week hold; a double-digit figure means the stop is too wide
  for the payoff to be realistic on that name.
- **Sh/$1k** — shares per $1,000 of risk (`1000 / risk_per_share`). Account-
  agnostic sizing: decide what you're willing to lose, multiply.

ATR uses true range where real highs and lows are stored, and falls back to
close-to-close change where they aren't; rows built on the fallback are flagged
in the row note, because that proxy understates range on gap days.

Two deliberate omissions. The regime score is carried as **context, not a
gate** — the backtest below found using it as a hard on/off filter was a net
drag, so it never removes a candidate. And nothing here knows about earnings
dates, news, or overnight gaps; a stop is a level, not a guarantee of the fill
you'll get.

## What's actually being computed

Full methodology (the five regime components, the sector momentum formula,
and the backtest results — including the honest finding that the regime
score performed *worse* as a tactical cash filter than the momentum ranking
alone) is in the header comments of `scripts/refresh.py` and was covered in
detail when this was first built. Short version:

- **Regime score** — a composite z-score across trend (50/200dma), breadth
  (RSP/SPY ratio), volatility (VIXY short/long ratio), credit (HYG/IEF
  ratio), and rate curve (IEF/SHY ratio), each normalized on a trailing
  252-day window.
- **Sector ranking** — the 11 SPDR sector ETFs ranked by blended 3/6/12-month
  momentum divided by realized volatility.
- **Backtest** (128 months, 2016–2026): equal-weight baseline 10.9% CAGR /
  -23.2% max drawdown; top-3 momentum 13.6% CAGR / -18.5% max drawdown;
  adding the regime score as a tactical filter actually *underperforms*
  (9.6% CAGR / -30.8% max drawdown) — it avoided real damage in the Feb 2020
  crash but was a net drag the other ~22 times it triggered. This is not
  financial advice — treat the whole thing as a probabilistic, evidence-based
  framework, not a mechanical buy/sell signal.

## Project layout

```
app/                        Next.js App Router pages + layout (fonts, metadata)
components/                 Terminal UI: gauges, regime chart, sector panel, backtest panel, ticker
lib/                        Supabase client, types, instrument registry, demo-data fallback, server-side data fetch
scripts/refresh.py          Reference implementation of the math (not part of the live path — see above)
supabase/schema.sql         Tables, RLS policies, Realtime config, and the pg_cron/pg_net job setup
supabase/functions/         The four Edge Functions that actually run the pipeline in production:
  ingest-prices/               writes raw_prices from fetched OHLCV bars
  compute-regime-score/        raw_prices -> regime_snapshot + regime_history
  compute-sector-rotation/     raw_prices -> sector_rankings
  compute-trade-setups/        raw_prices + symbol_meta -> rotation_strength + trade_setups
```
