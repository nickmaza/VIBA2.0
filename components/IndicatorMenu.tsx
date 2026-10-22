"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { INDICATORS, INDICATOR_BY_ID, newIndicator, type ActiveIndicator, type IndicatorDef } from "@/lib/indicators";

// The chart's indicator picker, laid out like Yahoo Finance's: a "Popular"
// shortlist, then every indicator grouped and searchable. Active indicators
// show as chips under the toolbar; a chip opens its settings, × removes it.

const GROUPS: IndicatorDef["group"][] = ["Moving averages", "Trend & bands", "Momentum", "Volatility", "Volume"];

export default function IndicatorMenu({
  active,
  onChange,
  colorOf,
}: {
  active: ActiveIndicator[];
  onChange: (next: ActiveIndicator[]) => void;
  /** swatch colour for a chip */
  colorOf: (a: ActiveIndicator) => string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open && !editing) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false);
        setEditing(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setEditing(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, editing]);

  const add = (id: string) => {
    const x = newIndicator(id, active);
    if (!x) return;
    onChange([...active, x]);
    setOpen(false);
    setQ("");
  };
  const remove = (uid: string) => onChange(active.filter((a) => a.uid !== uid));
  const setParam = (uid: string, key: string, value: number | string) =>
    onChange(active.map((a) => (a.uid === uid ? { ...a, params: { ...a.params, [key]: value } } : a)));

  const term = q.trim().toLowerCase();
  const matches = useMemo(() => INDICATORS.filter((d) => !term || d.name.toLowerCase().includes(term) || d.group.toLowerCase().includes(term)), [term]);
  const subCount = active.filter((a) => INDICATOR_BY_ID.get(a.id)?.pane === "sub").length;

  const item = (d: IndicatorDef) => (
    <li key={d.id}>
      <button
        type="button"
        onClick={() => add(d.id)}
        className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[11.5px] text-term-text hover:bg-term-panel2"
      >
        <span>{d.name}</span>
        <span className="text-[9.5px] uppercase text-term-dim">{d.pane === "sub" ? "lower pane" : "on price"}</span>
      </button>
    </li>
  );

  const editingDef = editing ? INDICATOR_BY_ID.get(active.find((a) => a.uid === editing)?.id ?? "") : undefined;
  const editingItem = active.find((a) => a.uid === editing);

  return (
    <div ref={box} className="relative flex flex-wrap items-center gap-1">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setEditing(null);
        }}
        className={`border px-2 py-0.5 text-[11px] ${open ? "border-term-brand text-term-brand" : "border-term-border text-term-text hover:border-term-borderStrong"}`}
      >
        ƒx Indicators ▾
      </button>

      {active.map((a) => {
        const d = INDICATOR_BY_ID.get(a.id);
        if (!d) return null;
        return (
          <span key={a.uid} className={`flex items-center border text-[10.5px] ${editing === a.uid ? "border-term-cyan" : "border-term-border"}`}>
            <button
              type="button"
              title="Settings"
              onClick={() => {
                setEditing(editing === a.uid ? null : a.uid);
                setOpen(false);
              }}
              className="flex items-center gap-1 px-1.5 py-0.5 text-term-text hover:text-term-cyan"
            >
              <span className="inline-block h-[2px] w-3" style={{ background: colorOf(a) }} />
              {d.short(a.params)}
            </button>
            <button type="button" aria-label={`Remove ${d.name}`} onClick={() => remove(a.uid)} className="border-l border-term-border px-1 text-term-dim hover:text-term-red">
              ×
            </button>
          </span>
        );
      })}
      {active.length > 0 && (
        <button type="button" onClick={() => onChange([])} className="px-1 text-[10px] text-term-dim hover:text-term-text">
          clear
        </button>
      )}

      {open && (
        <div role="menu" className="absolute left-0 top-[calc(100%+3px)] z-40 w-[300px] border border-term-borderStrong bg-term-panel shadow-xl">
          <div className="border-b border-term-border p-1.5">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search indicators"
              aria-label="Search indicators"
              className="w-full border border-term-border bg-term-bg px-2 py-1 text-[11.5px] text-term-text outline-none placeholder:text-term-dim focus:border-term-brand"
            />
            {subCount >= 4 && <div className="mt-1 text-[10px] text-term-amber">Four lower panes is the limit; remove one to add another oscillator.</div>}
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            {!term && (
              <>
                <div className="px-2 pt-1.5 text-[9.5px] font-bold uppercase tracking-wide text-term-dim">Popular</div>
                <ul className="m-0 list-none p-0">{INDICATORS.filter((d) => d.popular).map(item)}</ul>
              </>
            )}
            {GROUPS.map((g) => {
              const list = matches.filter((d) => d.group === g && (subCount < 4 || d.pane === "price"));
              if (!list.length) return null;
              return (
                <div key={g}>
                  <div className="border-t border-term-border/60 px-2 pt-1.5 text-[9.5px] font-bold uppercase tracking-wide text-term-dim">{g}</div>
                  <ul className="m-0 list-none p-0">{list.map(item)}</ul>
                </div>
              );
            })}
            {!matches.length && <div className="px-2 py-2 text-[11px] text-term-dim">No indicator matches “{q}”.</div>}
          </div>
        </div>
      )}

      {editingDef && editingItem && (
        <div className="absolute left-0 top-[calc(100%+3px)] z-40 w-[280px] border border-term-borderStrong bg-term-panel p-2 shadow-xl">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11.5px] font-bold text-term-text">{editingDef.name}</span>
            <button type="button" onClick={() => setEditing(null)} className="text-[11px] text-term-dim hover:text-term-text" aria-label="Close settings">
              ✕
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {editingDef.params.map((p) => (
              <label key={p.key} className="flex items-center justify-between gap-2 text-[11px] text-term-dim">
                {p.label}
                {p.options ? (
                  <select
                    value={String(editingItem.params[p.key])}
                    onChange={(e) => setParam(editingItem.uid, p.key, e.target.value)}
                    className="w-40 border border-term-border bg-term-bg px-1 py-0.5 text-[11px] text-term-text outline-none focus:border-term-brand"
                  >
                    {p.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="number"
                    value={Number(editingItem.params[p.key])}
                    min={p.min}
                    max={p.max}
                    step={p.step ?? 1}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      const clamped = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v));
                      setParam(editingItem.uid, p.key, clamped);
                    }}
                    className="w-24 border border-term-border bg-term-bg px-1 py-0.5 text-right font-mono text-[11px] text-term-text outline-none focus:border-term-brand"
                  />
                )}
              </label>
            ))}
          </div>
          <div className="mt-2 flex justify-between">
            <button type="button" onClick={() => remove(editingItem.uid)} className="text-[10.5px] text-term-red hover:underline">
              Remove
            </button>
            <button type="button" onClick={() => setEditing(null)} className="border border-term-brand px-2 py-0.5 text-[10.5px] text-term-brand">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
