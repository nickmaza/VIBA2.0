import type { ReactNode } from "react";
import { getTerminalData } from "@/lib/data";
import { INSTRUMENTS } from "@/lib/instruments";
import { analyze, isAnalysis, type Analysis, type Bars } from "@/lib/ta";
import { getBarsMany } from "@/lib/market";
import { getPlays } from "@/lib/plays";
import MenuBar from "@/components/MenuBar";
import Panel, { Chip } from "@/components/Panel";
import Ticker from "@/components/Ticker";
import QuoteCard from "@/components/QuoteCard";
import GaugePanel from "@/components/GaugePanel";
import RegimeChart from "@/components/RegimeChart";
import SectorPanel from "@/components/SectorPanel";
import SectorChart from "@/components/SectorChart";
import BacktestPanel from "@/components/BacktestPanel";
import TrackedInstruments from "@/components/TrackedInstruments";
import TradeSetups from "@/components/TradeSetups";
import RotationStrength from "@/components/RotationStrength";
import PipelineStatus from "@/components/PipelineStatus";
import AlertsPanel, { deriveAlerts } from "@/components/AlertsPanel";
import MessageCenter from "@/components/MessageCenter";
import Workspace from "@/components/Workspace";
import PlaysBoard, { PlaysSummary, type PlayView, type WatchView } from "@/components/PlaysBoard";
import ChartSearch from "@/components/ChartSearch";
import SmartMoneyPlays, { SmartMoneySummary } from "@/components/SmartMoneyPlays";
import SmartMoneyTab from "@/components/SmartMoneyTab";

export const revalidate = 0;

/**
 * The stock plays and watchlist computed in Supabase (compute-plays), each with
 * the setup engine's read of its latest bars (one bars_json_many round trip).
 */
async function getPlayViews() {
  const plays = await getPlays();
  const symbols = [...plays.plays.map((p) => p.symbol), ...plays.watchlist.map((w) => w.symbol)];
  let bars = new Map<string, Bars>();
  let barsError: string | null = null;
  if (symbols.length) {
    try {
      bars = await getBarsMany(symbols);
    } catch (e) {
      barsError = e instanceof Error ? e.message : String(e);
    }
  }
  const analysisOf = (s: string): Analysis | null => {
    const b = bars.get(s);
    if (!b) return null;
    const a = analyze(b);
    return isAnalysis(a) ? a : null;
  };
  const stocks: PlayView[] = plays.plays.map((p) => ({
    play: p,
    analysis: analysisOf(p.symbol),
    closes: bars.get(p.symbol)?.c.slice(-126) ?? [],
  }));
  const watch: WatchView[] = plays.watchlist.map((w) => ({ item: w, analysis: analysisOf(w.symbol) }));
  return { stocks, watch, asOf: plays.asOf, generatedAt: plays.generatedAt, error: plays.error ?? barsError };
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-2 py-3 text-[11px] text-term-dim">{children}</div>;
}

/**
 * VIBA Terminal. The page is a tabbed workspace; every tab is a grid of
 * dockable-looking windows in the same workstation style:
 *   Overview        -- regime quotes, today's plays at a glance, sector ladder, alerts
 *   Plays           -- stock plays and smart money plays with full trade plans
 *   Smart Money     -- money flow, rotation, risk appetite, options, insiders, 13F, congress
 *   Chart & Search  -- any ticker, interactive chart, auto levels and setups
 *   Regime / Sectors / Backtest / Pipeline -- the original analysis windows
 * A sticky menu bar sits on top and the ticker strip is pinned to the bottom.
 */
export default async function Home() {
  const [data, plays] = await Promise.all([getTerminalData(), getPlayViews()]);
  const errors = plays.error ? [...data.errors, `stock plays: ${plays.error}`] : data.errors;
  const priceBy = new Map(data.prices.map((p) => [p.symbol, p]));
  const reporting = INSTRUMENTS.filter((i) => priceBy.has(i.symbol)).length;
  const alerts = deriveAlerts({
    snapshot: data.snapshot,
    history: data.history,
    sectors: data.sectors,
    log: data.refreshLog,
    now: new Date(),
  });
  const order = ["SPY", "QQQ", "IWM"];
  const snaps = order
    .map((s) => data.snapshot.find((r) => r.index_symbol === s))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  const firstDate = data.history[0]?.d ?? "";
  const lastDate = data.history[data.history.length - 1]?.d ?? "";
  const rotationState = data.rotation.length ? data.rotation[data.rotation.length - 1].state : "n/a";
  const playCount = plays.stocks.length;
  const btMonths = data.curves.map((c) => c.month).sort();
  const btSpan = btMonths.length ? `${btMonths[0].slice(0, 4)}–${btMonths[btMonths.length - 1].slice(0, 4)}` : "no data";
  const top3 = data.stats.find((x) => x.strategy === "top3");
  const dual = data.stats.find((x) => x.strategy === "dual");
  const filterNote =
    top3 && dual
      ? dual.cagr < top3.cagr
        ? ` In the backtest, using the regime score as a tactical cash filter returned less than the momentum ranking on its own (${dual.cagr.toFixed(1)}% vs ${top3.cagr.toFixed(1)}% a year).`
        : ` In the backtest, using the regime score as a tactical cash filter returned more than the momentum ranking on its own (${dual.cagr.toFixed(1)}% vs ${top3.cagr.toFixed(1)}% a year), which does not mean it will again.`
      : "";

  const quoteCards = snaps.length ? (
    snaps.map((s) => (
      <Panel key={s.index_symbol} title={s.index_symbol} controls={<Chip>quote · regime</Chip>}>
        <QuoteCard snap={s} price={priceBy.get(s.index_symbol)} history={data.history} />
      </Panel>
    ))
  ) : (
    <Panel title="SPY / QQQ / IWM" controls={<Chip>regime_snapshot</Chip>}>
      <Empty>Regime scores are not available: {errors.find((e) => e.startsWith("regime_snapshot")) ?? "compute-regime-score has not written a snapshot yet."}</Empty>
    </Panel>
  );

  const spyChart = (
    <Panel
      title=".REGIME SPY"
      controls={
        <>
          <Chip active>MAX</Chip>
          <Chip>composite z</Chip>
        </>
      }
    >
      {data.history.length > 1 ? (
        <RegimeChart history={data.history} series={["spy"]} defaultRange="max" showEvents height={230} />
      ) : (
        <Empty>No regime history in Supabase yet.</Empty>
      )}
      <div className="flex justify-between border-t border-term-border px-2 py-0.5 text-[10px] text-term-dim">
        <span>{firstDate}</span>
        <span>daily sessions · red bands = drawdown events</span>
        <span>{lastDate}</span>
      </div>
    </Panel>
  );

  const sectorLadder = (
    <Panel
      title="Sector Rotation Ladder"
      controls={
        <>
          <Chip active>11 SPDRs</Chip>
          <Chip>as of {data.sectors[0]?.as_of ?? data.asOf}</Chip>
        </>
      }
    >
      {data.sectors.length ? <SectorPanel sectors={data.sectors} /> : <Empty>No sector ranking in Supabase yet.</Empty>}
    </Panel>
  );

  const rotationPanel = (
    <Panel
      title="Rotation Strength"
      controls={
        <>
          <Chip active>{rotationState}</Chip>
          <Chip>0-100</Chip>
        </>
      }
    >
      <RotationStrength rows={data.rotation} />
    </Panel>
  );

  const legsPanel = (
    <Panel title="Regime Composite — Legs" controls={<Chip>regime_snapshot</Chip>}>
      <GaugePanel snapshot={data.snapshot} />
    </Panel>
  );

  const alertsPanel = (
    <Panel title="Alerts" controls={<Chip>derived live</Chip>}>
      <AlertsPanel alerts={alerts} />
    </Panel>
  );

  const disclaimer = (
    <footer className="px-1 pb-1 text-[10px] leading-relaxed text-term-dim">
      <span className="font-semibold text-term-text">NOT FINANCIAL ADVICE.</span> Backtested statistical framework built
      from historical prices. Past performance of the composite score, the momentum ranking and the setup rules does not
      predict future results.{filterNote} Trade plans are rules-based arithmetic on daily bars, not predictions, and nothing here accounts
      for earnings dates, news or gaps. Smart money signals describe where volume and positioning lean; they are not forecasts.
      Market data: Yahoo Finance daily bars, CBOE delayed option chains, SEC EDGAR, Senate and House disclosures, all fetched
      and computed in Supabase.
    </footer>
  );

  const panels = {
    overview: (
      <div className="grid grid-cols-1 gap-[3px] lg:grid-cols-[minmax(0,1fr)_350px]">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className="grid grid-cols-1 gap-[3px] md:grid-cols-3">{quoteCards}</div>
          <Panel
            title="Stock Plays — at a glance"
            controls={
              <>
                <Chip active>{playCount} plays</Chip>
                <Chip>case as of {plays.asOf ?? "—"}</Chip>
                <a href="#plays" className="text-term-cyan hover:underline">
                  full plays →
                </a>
              </>
            }
          >
            <PlaysSummary rows={[{ label: "Stock plays", items: plays.stocks }]} />
          </Panel>
          <Panel
            title="Smart Money Plays — at a glance"
            controls={
              <a href="#smart" className="text-term-cyan hover:underline">
                smart money tab →
              </a>
            }
          >
            <SmartMoneySummary />
          </Panel>
          {disclaimer}
        </div>
        <div className="flex min-w-0 flex-col gap-[3px]">
          {legsPanel}
          {rotationPanel}
          {sectorLadder}
          {alertsPanel}
        </div>
      </div>
    ),

    plays: (
      <div className="flex flex-col gap-[3px]">
        <Panel
          title="VIBA Plays — Stocks & Smart Money"
          controls={
            <>
              <Chip active>{plays.stocks.length} stock plays</Chip>
              <Chip active>smart money plays</Chip>
              <Chip>no index products</Chip>
            </>
          }
        >
          <PlaysBoard
            stocks={plays.stocks}
            watchlist={plays.watch}
            asOf={plays.asOf}
            generatedAt={plays.generatedAt}
            error={plays.error}
            secondary={<SmartMoneyPlays />}
          />
        </Panel>
        <Panel
          title="Pipeline Candidates — Entry / Stop / Targets"
          controls={
            <>
              <Chip active>{data.setups.length} candidates</Chip>
              <Chip>long only</Chip>
              <Chip>trade_setups</Chip>
            </>
          }
        >
          <TradeSetups setups={data.setups} rotation={data.rotation} />
        </Panel>
        {disclaimer}
      </div>
    ),

    smart: (
      <div className="flex flex-col gap-[3px]">
        <SmartMoneyTab />
      </div>
    ),

    chart: (
      <div className="flex flex-col gap-[3px]">
        <ChartSearch defaultSymbol={plays.stocks[0]?.play.symbol ?? "SPY"} quick={plays.stocks.map((p) => p.play.symbol)} />
        {disclaimer}
      </div>
    ),

    regime: (
      <div className="grid grid-cols-1 gap-[3px] lg:grid-cols-[minmax(0,1fr)_350px]">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className="grid grid-cols-1 gap-[3px] xl:grid-cols-2">
            {spyChart}
            <Panel
              title=".REGIME SPY / QQQ / IWM"
              controls={
                <>
                  <Chip active>1Y</Chip>
                  <Chip>3 indices</Chip>
                </>
              }
            >
              {data.history.length > 1 ? (
                <RegimeChart history={data.history} series={["spy", "qqq", "iwm"]} defaultRange="1y" showEvents={false} height={230} />
              ) : (
                <Empty>No regime history in Supabase yet.</Empty>
              )}
              <div className="flex justify-between border-t border-term-border px-2 py-0.5 text-[10px] text-term-dim">
                <span>shaded: ≥ +1.25 strong risk-on · ≤ −1.25 crash-warning</span>
                <span>as of {data.asOf ?? "—"}</span>
              </div>
            </Panel>
          </div>
          <div className="grid grid-cols-1 gap-[3px] md:grid-cols-3">{quoteCards}</div>
        </div>
        <div className="flex min-w-0 flex-col gap-[3px]">
          {legsPanel}
          {alertsPanel}
        </div>
      </div>
    ),

    sectors: (
      <div className="grid grid-cols-1 gap-[3px] lg:grid-cols-[minmax(0,1fr)_350px]">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <Panel
            title="Sector Momentum"
            controls={
              <>
                <Chip active>RANKED</Chip>
                <Chip>risk-adj.</Chip>
              </>
            }
            bodyClassName="p-2"
          >
            {data.sectors.length ? <SectorChart sectors={data.sectors} /> : <Empty>No sector ranking in Supabase yet.</Empty>}
            <div className="mt-1 flex justify-between text-[10px] text-term-dim">
              <span>score = blended 3/6/12M momentum ÷ 126d vol</span>
              <span>bold = top-3 holdings</span>
            </div>
          </Panel>
          {rotationPanel}
        </div>
        <div className="flex min-w-0 flex-col gap-[3px]">{sectorLadder}</div>
      </div>
    ),

    backtest: (
      <div className="flex flex-col gap-[3px]">
        <Panel
          title="Backtest — Growth of $1"
          controls={
            <>
              <Chip active>{btSpan}</Chip>
              <Chip>monthly rebal · log</Chip>
            </>
          }
        >
          {data.curves.length ? (
            <BacktestPanel curves={data.curves} stats={data.stats} />
          ) : (
            <Empty>No backtest in Supabase yet (compute-backtest writes it daily).</Empty>
          )}
        </Panel>
        {disclaimer}
      </div>
    ),

    pipeline: (
      <div className="grid grid-cols-1 gap-[3px] lg:grid-cols-[270px_minmax(0,1fr)_350px]">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <Panel title="Pipeline" controls={<Chip>refresh_log</Chip>} bodyClassName="min-h-0">
            <PipelineStatus log={data.refreshLog} />
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <Panel
            title="Tracked Instruments"
            controls={
              <>
                <Chip active>All {INSTRUMENTS.length}</Chip>
                <Chip>{reporting} reporting</Chip>
                <Chip>latest_prices</Chip>
              </>
            }
          >
            <TrackedInstruments prices={data.prices} sectors={data.sectors} snapshot={data.snapshot} />
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <Panel title="Message Center" controls={<Chip>pipeline health</Chip>}>
            <MessageCenter
              asOf={data.asOf}
              errors={errors}
              pipeline={data.pipeline}
              symbolsReporting={reporting}
              symbolsTracked={INSTRUMENTS.length}
            />
          </Panel>
          {alertsPanel}
        </div>
      </div>
    ),
  };

  return (
    <main className="min-h-screen bg-term-bg pb-8">
      <MenuBar errors={errors} asOf={data.asOf} />
      <Workspace
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "plays", label: "Plays", badge: playCount },
          { id: "smart", label: "Smart Money" },
          { id: "chart", label: "Chart & Search" },
          { id: "regime", label: "Regime" },
          { id: "sectors", label: "Sectors" },
          { id: "backtest", label: "Backtest" },
          { id: "pipeline", label: "Pipeline" },
        ]}
        panels={panels}
      />
      <Ticker snapshot={data.snapshot} prices={data.prices} />
    </main>
  );
}
