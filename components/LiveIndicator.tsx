"use client";

export default function LiveIndicator({
  isLive,
  asOf,
}: {
  isLive: boolean;
  asOf: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isLive ? "bg-term-green live-dot" : "bg-term-yellow"
        }`}
      />
      <span className={isLive ? "text-term-green" : "text-term-yellow"}>
        {isLive ? "LIVE — SUPABASE" : "DEMO DATA"}
      </span>
      <span className="text-term-dim">· as of {asOf}</span>
    </div>
  );
}
