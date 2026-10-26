import Clock from "@/components/Clock";
import LiveIndicator from "@/components/LiveIndicator";
import RealtimeRefresher from "@/components/RealtimeRefresher";
import { TourButton } from "@/components/Tour";
import VibaLogo from "@/components/brand/VibaLogo";

/**
 * Workstation-style menu bar: brand, live status, clock, green accent stripe.
 * Section navigation lives in the tab strip right below it (Workspace).
 */
export default function MenuBar({ errors, asOf }: { errors: string[]; asOf: string | null }) {
  return (
    <div className="sticky top-0 z-20 border-b border-term-border bg-[#1a1a1a]">
      <div className="flex h-[26px] items-center gap-4 px-2">
        <a href="/" className="flex shrink-0 items-center" title="VIBA home" aria-label="VIBA home">
          <VibaLogo className="h-[15px] w-auto" ink="#f2f2f2" idSuffix="-menu" />
        </a>
        <span className="hidden text-[10.5px] text-term-dim md:inline">
          regime · rotation · plays · charts
        </span>
        <div className="ml-auto flex items-center gap-3 whitespace-nowrap text-term-dim">
          <TourButton />
          <span data-tour="status" className="flex items-center gap-3">
            <RealtimeRefresher />
            <LiveIndicator errors={errors} asOf={asOf} />
          </span>
          <Clock />
        </div>
      </div>
      <div className="h-[3px] bg-term-brand" />
    </div>
  );
}
