"use client";

/** Where the numbers come from, and whether every query behind this page succeeded. */
export default function LiveIndicator({ errors, asOf }: { errors: string[]; asOf: string | null }) {
  const ok = errors.length === 0;
  return (
    <div className="flex items-center gap-2 text-[11px]" title={ok ? "Every panel was read from Supabase" : errors.join("\n")}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-term-green live-dot" : "bg-term-red"}`} />
      <span className={ok ? "text-term-green" : "text-term-red"}>
        {ok ? "SUPABASE" : `SUPABASE · ${errors.length} QUER${errors.length === 1 ? "Y" : "IES"} FAILED`}
      </span>
      <span className="hidden text-term-dim sm:inline">· scores as of {asOf ?? "—"}</span>
    </div>
  );
}
