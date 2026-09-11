import type { ReactNode } from "react";

/**
 * Window chrome for one tile of the workstation grid: a gray title bar with a
 * small icon, the panel name, optional right-side controls, and a body.
 * Every panel on the page is one of these so the grid reads as a set of
 * dockable windows rather than a web page.
 */
export default function Panel({
  id,
  title,
  controls,
  children,
  className = "",
  bodyClassName = "",
  scrollX = false,
}: {
  id?: string;
  title: string;
  controls?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  scrollX?: boolean;
}) {
  return (
    <section
      id={id}
      className={`flex min-w-0 flex-col border border-term-border bg-term-panel ${className}`}
    >
      <header className="panel-title flex h-[22px] shrink-0 items-center gap-1.5 border-b border-term-border px-1.5">
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 border border-term-borderStrong bg-term-panel2"
        />
        <span className="truncate text-[11px] font-bold uppercase tracking-wide text-term-text">
          {title}
        </span>
        {controls && (
          <span className="ml-auto flex min-w-0 items-center gap-2 text-[10px] text-term-dim">
            {controls}
          </span>
        )}
        <span aria-hidden className={`${controls ? "" : "ml-auto "}text-[10px] text-term-dim`}>
          ▾
        </span>
      </header>
      <div className={`min-w-0 flex-1 ${scrollX ? "overflow-x-auto" : ""} ${bodyClassName}`}>
        {children}
      </div>
    </section>
  );
}

/** Small inline "toolbar chip" used in panel title bars (e.g. "1Y · DAILY"). */
export function Chip({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return (
    <span
      className={`border px-1 leading-[14px] ${
        active
          ? "border-term-borderStrong bg-term-panel2 text-term-text"
          : "border-term-border text-term-dim"
      }`}
    >
      {children}
    </span>
  );
}
