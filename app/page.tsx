import { getTerminalData } from "@/lib/data";
import { INSTRUMENTS } from "@/lib/instruments";
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
import PipelineStatus from "@/components/PipelineStatus";
import AlertsPanel, { deriveAlerts } from "@/components/AlertsPanel";
import MessageCenter from "@/components/MessageCenter";

export const revalidate = 0;

/**
 * Workstation layout: a dense three-column grid of dockable-looking windows.
 *   left   -- pipeline feed (news-style) + one quote card per regime index
 *   middle -- 2x2 chart windows, then the positions-style instruments table
 *   right  -- composite "ticket" (the 5 legs), sector ladder, alerts, message center
 * plus a sticky menu bar on top and a scrolling ticker strip pinned to the bottom.
 * Collapses to a single column on narrow screens.
 */
export default async function Home() {
  const data = await getTerminalData();
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

  return (
    <main className="min-h-screen bg-term-bg pb-8">
      <MenuBar isLive={data.isLive} asOf={data.asOf} />

      <div className="grid grid-cols-1 gap-[3px] p-[3px] lg:grid-cols-[270px_minmax(0,1fr)_350px]">
        {/* ---------------- left column ---------------- */}
        <div className="flex min-w-0 flex-col gap-[3px]">
          <Panel
            id="pipeline"
            title="Pipeline"
            controls={<Chip>refresh_log</Chip>}
            className="lg:h-[430px]"
            bodyClassName="min-h-0"
          >
            <PipelineStatus log={data.refreshLog} />
          </Panel>
          {snaps.map((s) => (
            <Panel
              key={s.index_symbol}
              id={s.index_symbol === "SPY" ? "regime" : undefined}
              title={s.index_symbol}
              controls={<Chip>quote · regime</Chip>}
            >
              <QuoteCard snap={s} price={priceBy.get(s.index_symbol)} history={data.history} />
            </Panel>
          ))}
        </div>

        {/* ---------------- middle column ---------------- */}
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div id="charts" className="grid grid-cols-1 gap-[3px] xl:grid-cols-2">
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

            <Panel
              id="backtest"
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
          </div>

          <Panel
            id="instruments"
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

          <footer className="px-1 pb-1 text-[10px] leading-relaxed text-term-dim">
            <span className="font-semibold text-term-text">NOT FINANCIAL ADVICE.</span> Backtested statistical
            framework built from historical ETF closes. Past performance of the composite score and momentum
            ranking does not predict future results; in backtest, using the regime score as a tactical cash
            filter underperformed the momentum ranking on its own. Data refreshes on a market-hours schedule
            from daily bars — this is not a tick-by-tick quote feed.
          </footer>
        </div>

        {/* ---------------- right column ---------------- */}
        <div className="flex min-w-0 flex-col gap-[3px]">
          <Panel
            title="Regime Composite — Legs"
            controls={<Chip>regime_snapshot</Chip>}
          >
            <GaugePanel snapshot={data.snapshot} />
          </Panel>

          <Panel
            id="sectors"
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

          <Panel id="alerts" title="Alerts" controls={<Chip>derived live</Chip>}>
            <AlertsPanel alerts={alerts} />
          </Panel>

          <Panel title="Message Center" controls={<Chip>pipeline health</Chip>}>
            <MessageCenter asOf={data.asOf} isLive={data.isLive} log={data.refreshLog} symbolsReporting={reporting} />
          </Panel>
        </div>
      </div>

      <Ticker snapshot={data.snapshot} prices={data.prices} />
    </main>
  );
}
