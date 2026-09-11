import Clock from "@/components/Clock";
import LiveIndicator from "@/components/LiveIndicator";
import RealtimeRefresher from "@/components/RealtimeRefresher";

const MENU = [
  { label: "Regime", href: "#regime" },
  { label: "Charts", href: "#charts" },
  { label: "Sectors", href: "#sectors" },
  { label: "Instruments", href: "#instruments" },
  { label: "Pipeline", href: "#pipeline" },
  { label: "Backtest", href: "#backtest" },
  { label: "Alerts", href: "#alerts" },
];

/** Workstation-style menu bar: brand, menu items, live status, clock, green accent stripe. */
export default function MenuBar({ isLive, asOf }: { isLive: boolean; asOf: string }) {
  return (
    <div className="sticky top-0 z-20 border-b border-term-border bg-[#1a1a1a]">
      <div className="flex h-[26px] items-center gap-4 px-2">
        <span className="whitespace-nowrap text-[12px] font-bold tracking-wide text-term-brand">
          REGIME<span className="text-term-text">//</span>ROTATION{" "}
          <span className="font-normal text-term-dim">Terminal</span>
        </span>
        <nav className="hidden items-center gap-4 text-[11px] text-term-text md:flex">
          {MENU.map((m) => (
            <a key={m.href} href={m.href} className="hover:text-term-brand">
              {m.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 whitespace-nowrap text-term-dim">
          <RealtimeRefresher />
          <LiveIndicator isLive={isLive} asOf={asOf} />
          <Clock />
        </div>
      </div>
      <div className="h-[3px] bg-term-brand" />
    </div>
  );
}
