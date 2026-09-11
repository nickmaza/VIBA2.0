import { getTerminalData } from "@/lib/data";
import Clock from "@/components/Clock";
import LiveIndicator from "@/components/LiveIndicator";
import Ticker from "@/components/Ticker";
import GaugePanel from "@/components/GaugePanel";
import RegimeChart from "@/components/RegimeChart";
import SectorPanel from "@/components/SectorPanel";
import BacktestPanel from "@/components/BacktestPanel";
import TrackedInstruments from "@/components/TrackedInstruments";
import PipelineStatus from "@/components/PipelineStatus";
import RealtimeRefresher from "@/components/RealtimeRefresher";

export const revalidate = 0;

function PanelHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-term-amber">
        {title}
      </h2>
      {sub && <span className="text-[11px] text-term-dim">{sub}</span>}
    </div>
  );
}

export default async function Home() {
  const data = await getTerminalData();

  return (
    <main className="min-h-screen bg-term-bg pb-10">
      <RealtimeRefresher />

      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-term-border px-4 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[15px] font-bold tracking-widest text-term-text">
            REGIME<span className="text-term-amber">//</span>ROTATION
          </h1>
          <span className="hidden text-[11px] text-term-dim sm:inline">
            SPY · QQQ · IWM &nbsp;|&nbsp; 11 SECTOR SPDRs
          </span>
        </div>
        <div className="flex items-center gap-4 text-term-dim">
          <LiveIndicator isLive={data.isLive} asOf={data.asOf} />
          <Clock />
        </div>
      </header>

      <Ticker snapshot={data.snapshot} sectors={data.sectors} />

      <div className="mx-auto flex max-w-[1400px] flex-col gap-5 px-4 pt-5">
        <section>
          <PanelHeader
            title="Market Regime Monitor"
            sub="Composite z-score, broken out into its 5 weighted components"
          />
          <GaugePanel snapshot={data.snapshot} history={data.history} />
        </section>

        <section className="border border-term-border bg-term-panel p-3">
          <PanelHeader title="SPY Composite Regime Score — 2017–Present" sub="hover to inspect" />
          <RegimeChart history={data.history} />
        </section>

        <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <PanelHeader title="Sector Rotation Ranking" sub="risk-adj. blended momentum" />
            <SectorPanel sectors={data.sectors} />
          </div>
          <div>
            <PanelHeader title="Sector Rotation — Backtest" sub="growth of $1 · monthly rebal" />
            <BacktestPanel curves={data.curves} stats={data.stats} />
          </div>
        </section>

        <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <PanelHeader
              title="Tracked Instruments"
              sub={`all ${data.prices.length || 19} symbols the pipeline reads`}
            />
            <TrackedInstruments prices={data.prices} />
          </div>
          <div>
            <PanelHeader title="Pipeline Status" sub="last 12 refresh runs, live" />
            <PipelineStatus log={data.refreshLog} />
          </div>
        </section>

        <footer className="border-t border-term-border pt-3 text-[11px] leading-relaxed text-term-dim">
          <span className="text-term-text font-semibold">NOT FINANCIAL ADVICE.</span> Backtested
          statistical framework built from historical ETF price data. Past performance of the
          composite score and momentum ranking does not predict future results. Applying the
          regime score as a tactical cash filter underperformed running the momentum ranking on
          its own in backtest — see the project README for the full write-up. Data refreshes on a
          market-hours schedule; this is not a millisecond quote feed.
        </footer>
      </div>
    </main>
  );
}
