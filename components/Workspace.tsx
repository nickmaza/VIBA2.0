"use client";

import { useEffect, useState, type ReactNode } from "react";

export interface WorkspaceTab {
  id: string;
  label: string;
  badge?: string | number;
}

/**
 * Tabbed workspace: one strip of tabs under the menu bar, one panel per tab.
 * Every panel is rendered on the server and kept in the DOM (just hidden), so
 * switching tabs is instant and charts keep their state. The active tab lives
 * in the URL hash (#plays, #chart, #chart/NVDA ...) so links and the browser
 * back button work, and is remembered between visits.
 */
export default function Workspace({ tabs, panels }: { tabs: WorkspaceTab[]; panels: Record<string, ReactNode> }) {
  const ids = tabs.map((t) => t.id);
  const [active, setActive] = useState(ids[0]);

  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace(/^#/, "").split("/")[0];
      if (ids.includes(h)) {
        setActive(h);
        try {
          localStorage.setItem("viba-tab", h);
        } catch {}
        return true;
      }
      return false;
    };
    if (!fromHash()) {
      try {
        const saved = localStorage.getItem("viba-tab");
        if (saved && ids.includes(saved)) setActive(saved);
      } catch {}
    }
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (id: string) => {
    setActive(id);
    try {
      localStorage.setItem("viba-tab", id);
      history.replaceState(null, "", `#${id}`);
    } catch {}
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <div
        role="tablist"
        aria-label="VIBA Terminal sections"
        className="sticky top-[30px] z-10 flex gap-px overflow-x-auto border-b border-term-border bg-[#161616] px-[3px] pt-[3px]"
      >
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              onClick={() => select(t.id)}
              className={`flex shrink-0 items-center gap-1.5 border border-b-0 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide focus-visible:outline focus-visible:outline-1 focus-visible:outline-term-brand ${
                on
                  ? "border-term-borderStrong bg-term-panel text-term-text shadow-[inset_0_2px_0_#6cb33f]"
                  : "border-term-border bg-term-bg text-term-dim hover:text-term-text"
              }`}
            >
              {t.label}
              {t.badge !== undefined && (
                <span className="border border-term-border px-1 font-mono text-[9.5px] font-normal text-term-dim">{t.badge}</span>
              )}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" hidden={t.id !== active} className="p-[3px]">
          {panels[t.id]}
        </div>
      ))}
    </>
  );
}
