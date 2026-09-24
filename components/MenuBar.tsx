import Clock from "@/components/Clock";
import LiveIndicator from "@/components/LiveIndicator";
import RealtimeRefresher from "@/components/RealtimeRefresher";

/**
 * Workstation-style menu bar: brand, live status, clock, green accent stripe.
 * Section navigation lives in the tab strip right below it (Workspace).
 */
export default function MenuBar({ isLive, asOf }: { isLive: boolean; asOf: string }) {
  return (
    <div className="sticky top-0 z-20 border-b border-term-border bg-[#1a1a1a]">
      <div className="flex h-[26px] items-center gap-4 px-2">
        <a href="#overview" className="whitespace-nowrap text-[12px] font-bold tracking-wide text-term-brand">
          VIBA <span className="font-normal text-term-text">Terminal</span>
        </a>
        <span className="hidden text-[10.5px] text-term-dim md:inline">
          regime · rotation · plays · charts
        </span>
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
