# VIBA Terminal

A trading-workstation style dashboard for the US market: a composite regime
score for SPY / QQQ / IWM, a sector rotation ranking, stock plays with exact
trade plans, a smart money tab (money flow, options, insiders, 13F funds,
congressional trades) and an interactive chart for any US stock or ETF.
Next.js 14 (App Router) on top of Supabase.

**Every number on screen comes from Supabase.** Edge functions running on
`pg_cron` pull real market data, store it, and compute every score inside the
project; the app only reads. There is no demo dataset, no bundled snapshot
and no simulated data anywhere: if a query fails, the panel says so and
renders empty, and the header badge turns red with the failing query.

## Where the data comes from

| Data | Source | Edge function | Tables | Schedule (New York time) |
|---|---|---|---|---|
| Daily OHLCV for the whole library (2,100+ stocks and ETFs) | Yahoo Finance chart API, Nasdaq historical API as fallback | `sync-prices` | `raw_prices`, `symbol_stats` | Market ETFs and every name on screen every 15 min, 09:30–16:50 weekdays; the whole library after each close (from 16:30) |
| Bars for any ticker you chart | same | `fetch-bars` (called by `/api/bars`) | `raw_prices` | On request; refreshes a symbol older than 15 min in the session, 12 h otherwise |
| US listings directory, market caps, industries, SEC CIKs | Nasdaq screener, SEC `company_tickers.json` | `sync-directory` | `symbol_directory`, `symbol_meta` | Weekly (Sunday) |
| Options activity per underlying (call/put volume, premium, open interest, IV30) | CBOE delayed option chains | `sync-options` | `options_daily`, view `options_latest` | 100 most active chains hourly in the session; every optionable name after each close |
| Insider open-market buys and sells | SEC EDGAR daily index + Form 4 filings | `sync-insiders` | `sec_form4_queue`, `insider_trades` | Index every 2 h; queued filings every 5 min |
| Hedge-fund positioning (12 tracked funds) | SEC EDGAR 13F-HR filings | `sync-13f` | `fund_filings`, `fund_holdings`, `smart_money_reports('funds')` | Daily |
| Congressional trades (STOCK Act) | Senate eFD and House Clerk periodic transaction reports; party from the congress-legislators dataset | `sync-congress` | `congress_filings`, `congress_trades`, `congress_members` | :07 and :37 every hour |

| Computed | Edge function | Tables | Schedule |
|---|---|---|---|
| Regime score (SPY, QQQ, IWM) | `compute-regime-score` | `regime_snapshot`, `regime_history` | Every 15 min, 09:30–17:00 weekdays; full rebuild Sundays |
| Sector ranking | `compute-sector-rotation` | `sector_rankings` | Every 15 min, 09:30–17:00 weekdays |
| Rotation strength and trade setups | `compute-trade-setups` | `rotation_strength`, `trade_setups` | Every 15 min in the session, and after the evening sweep |
| Stock plays and watchlist | `compute-plays` | `stock_plays` | Every 30 min in the session, and after the evening sweep |
| Smart money report | `compute-smart-money` | `smart_money_reports('smart_money')` | Hourly in the session, and after the evening sweep |
| Sector-rotation backtest | `compute-backtest` | `backtest_curves`, `backtest_stats` | Daily, 16:55 |

The schedule lives in `supabase/migrations/20260927_schedules.sql`. `pg_cron`
runs in UTC, so each job gates itself to New York hours in SQL (daylight
saving is handled; exchange holidays are not modeled, so on a holiday the jobs
re-read the previous session). The after-close sweeps run until every library
symbol and every option chain has the new session, and a dependent job then
rebuilds the setups, plays and smart money report once.

## How the pipeline runs

- `pg_cron` calls `private.invoke_edge(fn, body)`, which posts to the edge
  function with the `x-refresh-secret` header. The secret lives only in
  Supabase Vault (`refresh_secret`); the functions read it through the
  service-role-only RPC `edge_refresh_secret()`, so it appears nowhere in the
  code. Re-running `supabase/migrations/20260927_edge_secret.sql` rotates it.
- The functions write with the service role key that Supabase injects into
  their environment. The anon key used by the app can only read: row-level
  security allows `SELECT` and nothing else, and the table-level write grants
  are revoked as well.
- Every run appends a row to `refresh_log` (the `pipeline_status` view keeps
  the latest run of each job with 24-hour tallies). The app subscribes to
  `refresh_log` inserts over Supabase Realtime and re-reads whatever changed,
  so open tabs stay current without polling.
- The sources are free and public, so the functions pace themselves: CBOE's
  CDN throttles bursts (the options sweep backs off automatically), SEC EDGAR
  is kept under its 10 requests/second fair-access limit and identifies itself
  with `pipeline_config.sec_user_agent`, and Yahoo symbols are fetched six at
  a time with the Nasdaq API as a fallback.

## 1. Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. The app reads the VIBA Supabase project out of the
box (`lib/supabase.ts`). To point it at another project, copy `.env.example` to
`.env.local` and set `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. Both are public values: the anon key cannot
write.

## 2. Setting up a fresh Supabase project (only for a copy)

1. Run `supabase/schema.sql`, then every file in `supabase/migrations/` in
   filename order. Change the project URL inside `private.invoke_edge` (in
   `20260926_real_data_pipeline.sql`) to your project's.
2. Deploy the functions (they authenticate with the refresh secret, not a JWT):

   ```bash
   for f in sync-prices fetch-bars sync-directory sync-options sync-insiders sync-13f sync-congress \
            compute-regime-score compute-sector-rotation compute-trade-setups compute-plays \
            compute-smart-money compute-backtest; do
     supabase functions deploy $f --no-verify-jwt
   done
   ```

3. Optionally set `pipeline_config.sec_user_agent` to a name and contact email;
   the SEC asks automated clients to identify themselves.
4. Seed the library in `symbol_meta` (the sector ETFs, regime inputs and flow
   ETFs are inserted by the migrations; stocks are added with their sector ETF).
   The schedule backfills everything else on its own: prices and option chains
   for every symbol that has never been synced, the Form 4 queue, congressional
   filings and 13Fs. To start at once, call the functions through SQL, e.g.
   `select private.invoke_edge('sync-directory', '{}');`.

## 3. Deploy to Vercel

```bash
npm i -g vercel   # if you don't have it
vercel
```

No environment variables are required. The service role key never goes to
Vercel: all writes happen inside Supabase.

## What the terminal shows

The UI is laid out like a desktop trading workstation: a menu bar, a tab strip,
dense grids of titled windows (`components/Panel.tsx`) and a scrolling ticker
strip pinned to the bottom. It collapses to one column on phones.

| Tab | What's in it |
|---|---|
| **Overview** | SPY / QQQ / IWM quote cards with their regime score, stock plays and smart money plays at a glance, regime legs, rotation strength, sector ladder, alerts |
| **Plays** | Stock plays (compute-plays) and smart money plays (compute-smart-money), each with the written case and a trade plan computed from its own bars (entry, stop, TP 1, TP 2, reward:risk, checklist), the watchlist, and the pipeline's trade setups |
| **Smart Money** | Money flow by sector and asset class, rotation map vs SPY, risk-appetite pairs, options positioning, accumulation leaders, insider buying, 13F fund moves, congressional trades |
| **Chart & Search** | Search any US stock or ETF (library + full listings directory); daily candlestick / bar chart with volume, 21/50/200-day averages, auto support and resistance, and the plan for every setup the engine finds |
| **Regime** | SPY and SPY/QQQ/IWM regime charts with range buttons, bucket thresholds and drawdown shading; the five legs of the composite |
| **Sectors** | Ranked sector momentum chart, rotation strength history, sector ladder |
| **Backtest** | Growth of $1 for four strategies with CAGR / volatility / Sharpe / max drawdown, recomputed daily from the stored history |
| **Pipeline** | Every pipeline run from `refresh_log`, the tracked instruments table, and the message center: last run of each job, failures in the last 24 hours, and a countdown to the next scheduled runs |

The `RT` badge in the menu bar shows the Realtime subscription and the latest
pipeline run; the `SUPABASE` badge next to it turns red and names the query if
any read behind the page failed.

### Units, so nothing gets misread

- Regime score and its five legs are **z-scores** (unitless, typically −3…+3).
- Sector `r3` / `r6` / `r12` are stored as **percent** (`12.9` = +12.9%).
- Sector `score` is unitless (blended momentum ÷ annualized vol).
- `latest_prices.chg_pct` is percent; `chg` is in price units.
- Options premium is contracts traded × last trade price × 100, in dollars.

## The plays, and what the numbers mean

**Stock plays** (`compute-plays`): inside the top three sectors, library stocks
that trade above their 50- and 200-day averages on at least $50M a day are
ranked by the average of their 3/6/12-month returns divided by 63-day
volatility. The top two per sector are plays and the next one goes on the
watchlist. Every word of each case is generated from the stock's own numbers,
and the chart read comes from the same setup engine (`lib/ta.ts`) the browser
runs. No index products (SPY, QQQ, IWM, DIA or their leveraged versions) are
ever plays.

**Smart money plays** (`compute-smart-money`): large caps where the volume flow
leans to accumulation, options traders are paying more for calls than puts, and
price is above its 50- and 200-day averages. Congressional and insider activity
are shown as supporting evidence.

**Trade setups** (`compute-trade-setups`) answer two questions.

*Is this rotation worth trading?* `rotation_strength` blends three readings,
each scored against its own trailing year (40/35/25):

- **Dispersion**: the cross-sectional standard deviation of the 11 sector
  scores. If every sector moves together there is nothing to rotate into.
- **Leader gap**: mean of the top 3 scores minus mean of the bottom 3.
- **Persistence**: Spearman rank correlation between today's ranking and the
  ranking 21 sessions ago. Wide dispersion with low persistence is labelled
  `churn`, not `strong`.

*What do I buy, and where are my levels?* The top three sector ETFs plus the
strongest stocks inside them (3/6-month blend per unit of 126-day volatility,
at least $20M a day). Levels are arithmetic:

- **Stop**: 2 ATR below the close, dropped under the 20-day low when structure
  sits lower, capped at 3 ATR.
- **Targets**: T1 at 2R and T2 at 3R, so reward:risk is constant by
  construction.
- **ATR→T1**: how many daily ATRs price has to cover to reach T1, the
  feasibility check a fixed R multiple hides.
- **Sh/$1k**: shares per $1,000 of risk.

The regime score is **context, not a gate**, and nothing here knows about
earnings dates, news or overnight gaps; a stop is a level, not a guaranteed fill.

## What's actually being computed

- **Regime score**: a composite across trend (price vs 50/200-day averages),
  breadth (RSP/SPY), volatility (VIXY 10-day vs 60-day average), credit
  (HYG/IEF) and rate curve (IEF/SHY), each a z-score on a trailing 252-day
  window, weighted 25/25/20/20/10 and z-scored again.
- **Sector ranking**: the 11 SPDR sector ETFs ranked by blended 3/6/12-month
  momentum (0.2/0.3/0.5) divided by 126-day realized volatility.
- **Backtest**: monthly rebalancing since 2016 on dividend-adjusted closes:
  equal weight (baseline), top 3 by the sector score, top 3 with the regime
  score as a cash filter (1–3y Treasuries when SPY's score is at or below
  −0.4), and bottom 3 as a sanity check. The Backtest tab shows the current
  results. So far the regime filter has returned less than the momentum
  ranking on its own, which is why it is used as context rather than a switch.

This is not financial advice. Treat it as an evidence-based framework, not a
mechanical buy/sell signal.

## Project layout

```
app/                         Next.js App Router page, layout and API routes
  api/bars                     one symbol's bars via the fetch-bars edge function
  api/search                   search_symbols() RPC
  api/smart-money[/insiders|/funds]   reports and insider trades from Supabase
components/                  Terminal UI (panels, charts, plays, smart money, pipeline)
lib/                         Supabase client and readers (data, plays, market, smartmoney), setup engine (ta.ts)
supabase/schema.sql          Base tables, RLS and the latest_prices view
supabase/migrations/         The data pipeline: tables, RPCs, Vault secret, pg_cron schedule, read grants
supabase/functions/          Edge functions (Deno):
  _shared/                     helpers, Yahoo/Nasdaq price client, setup engine and money-flow copies
  sync-prices, fetch-bars      daily bars -> raw_prices, symbol_stats
  sync-directory               listings, market caps, CIKs
  sync-options                 CBOE chains -> options_daily
  sync-insiders, sync-13f      SEC EDGAR Form 4 and 13F
  sync-congress                Senate and House STOCK Act reports
  compute-*                    regime, sectors, setups, plays, smart money, backtest
  ingest-prices                retired (returns 410): prices come only from sync-prices
```
