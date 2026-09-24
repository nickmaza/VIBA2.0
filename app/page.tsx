import { getTerminalData } from "@/lib/data";
import { INSTRUMENTS } from "@/lib/instruments";
import { analyze, isAnalysis, type Analysis } from "@/lib/ta";
import { getBars, type BarsResult } from "@/lib/market";
import { ALL_PLAYS, LEVERAGED_PLAYS, PLAYS_AS_OF, STOCK_PLAYS, WATCHLIST, type Play } from "@/lib/plays";
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

export const revalidate = 0;

/** Price bars + setup analysis for every play and watchlist name, fetched in parallel. */
async function getPlayViews() {
  const symbols = [...ALL_PLAYS.map((p) => p.symbol), ...WATCHLIST.map((w) => w.symbol)];
  const results = await Promise.all(symbols.map((s) => getBars(s).catch(() => null)));
  const bars = new Map<string, BarsResult | null>(symbols.map((s, i) => [s, results[i]]));
  const analysisOf = (s: string): Analysis | null => {
    const r = bars.get(s);
    if (!r) return null;
    const a = analyze(r.bars);
    return isAnalysis(a) ? a : null;
  };
  const view = (p: Play): PlayView => ({
    play: p,
    analysis: analysisOf(p.symbol),
    closes: bars.get(p.symbol)?.bars.c.slice(-126) ?? [],
    source: bars.get(p.symbol)?.source ?? null,
  });
  const watch: WatchView[] = WATCHLIST.map((w) => ({ item: w, analysis: analysisOf(w.symbol) }));
  return { stocks: STOCK_PLAYS.map(view), leveraged: LEVERAGED_PLAYS.map(view), watch };
}

/**
 * VIBA Terminal. The page is a tabbed workspace; every tab is a grid of
 * dockable-looking windows in the same workstation style:
 *   Overview        -- regime quotes, today's plays at a glance, rotation, sector ladder, alerts
 *   Plays           -- stock plays and leveraged-ETF plays with full trade plans
 *   Chart & Search  -- any ticker, interactive chart, auto levels and setups
 *   Regime / Sectors / Backtest / Pipeline -- the original analysis windows
 * A sticky menu bar sits on top and the ticker strip is pinned to the bottom.
 */
export default async function Home() {
  const [data, plays] = await Promise.all([getTerminalData(), getPlayViews()]);
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
  const regimeLine = snaps.map((s) => `${s.index_symbol} ${s.bucket} (${s.score >= 0 ? "+" : ""}${s.score.toFixed(2)})`).join(", ");
  const rotationState = data.rotation.length ? data.rotation[data.rotation.length - 1].state : "n/a";
  const playCount = plays.stocks.length + plays.leveraged.length;

  const quoteCards = snaps.map((s) => (
    <Panel key={s.index_symbol} title={s.index_symbol} controls={<Chip>quote · regime</Chip>}>
      <QuoteCard snap={s} price={priceBy.get(s.index_symbol)} history={data.history} />
    </Panel>
  ));

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
      <RegimeChart history={data.history} series={["spy"]} defaultRange="max" showEvents height={230} />
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
      <SectorPanel sectors={data.sectors} />
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
      predict future results; in backtest, using the regime score as a tactical cash filter underperformed the momentum
      ranking on its own. Trade plans are rules-based arithmetic on daily bars, not predictions, and nothing here accounts
      for earnings dates, news or gaps. Leveraged ETFs reset daily and can lose most of their value quickly.
    </footer>
  );

  const panels = {
    overview: (
      <div className="grid grid-cols-1 gap-[3px] lg:grid-cols-[minmax(0,1fr)_350px]">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className="grid grid-cols-1 gap-[3px] md:grid-cols-3">{quoteCards}</div>
          <Panel
            title="VIBA Plays — at a glance"
            controls={
              <>
                <Chip active>{playCount} plays</Chip>
                <Chip>case as of {PLAYS_AS_OF}</Chip>
                <a href="#plays" className="text-term-cyan hover:underline">
                  full plays →
                </a>
              </>
            }
          >
            <PlaysSummary
              rows={[
                { label: "Stock plays", items: plays.stocks },
                { label: "Leveraged ETF plays", items: plays.leveraged },
              ]}
            />
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
          title="VIBA Plays — Stocks & Leveraged ETFs"
          controls={
            <>
              <Chip active>{plays.stocks.length} stocks</Chip>
              <Chip active>{plays.leveraged.length} leveraged</Chip>
              <Chip>no index products</Chip>
            </>
          }
        >
          <PlaysBoard stocks={plays.stocks} leveraged={plays.leveraged} watchlist={plays.watch} regimeLine={regimeLine} />
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

    chart: (
      <div className="flex flex-col gap-[3px]">
        <ChartSearch defaultSymbol={ALL_PLAYS[0].symbol} quick={ALL_PLAYS.map((p) => p.symbol)} snapshotDate={PLAYS_AS_OF} />
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
              <RegimeChart history={data.history} series={["spy", "qqq", "iwm"]} defaultRange="1y" showEvents={false} height={230} />
              <div className="flex justify-between border-t border-term-border px-2 py-0.5 text-[10px] text-term-dim">
                <span>shaded: ≥ +1.25 strong risk-on · ≤ −1.25 crash-warning</span>
                <span>as of {data.asOf}</span>
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
            <SectorChart sectors={data.sectors} />
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
              <Chip active>2016–2026</Chip>
              <Chip>monthly rebal · log</Chip>
            </>
          }
        >
          <BacktestPanel curves={data.curves} stats={data.stats} />
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
            <MessageCenter asOf={data.asOf} isLive={data.isLive} log={data.refreshLog} symbolsReporting={reporting} />
          </Panel>
          {alertsPanel}
        </div>
      </div>
    ),
  };

  return (
    <main className="min-h-screen bg-term-bg pb-8">
      <MenuBar isLive={data.isLive} asOf={data.asOf} />
      <Workspace
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "plays", label: "Plays", badge: playCount },
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
