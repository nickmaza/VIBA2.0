"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import Panel, { Chip } from "@/components/Panel";
import { LivePrice } from "@/lib/live";

// A live news feed modeled on Yahoo Finance's quote-page "Recent News":
// tabs (All / News / Press releases), headline + publisher + age +
// related tickers with their live % change, new stories announced as they
// arrive ("3 new stories"), and "Load more" paging by publish time.
// Stories come from news_items, written by the sync-news edge function.

interface Story {
  uuid: string;
  title: string;
  publisher: string | null;
  link: string;
  kind: "STORY" | "VIDEO" | "PRESS";
  published_at: string;
  tickers: string[];
  thumb: string | null;
}

const COLS = "uuid,title,publisher,link,kind,published_at,tickers,thumb";
const TABS = [
  { id: "all", label: "All" },
  { id: "STORY", label: "News" },
  { id: "PRESS", label: "Press releases" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const INDEX_NAMES: Record<string, string> = { "^GSPC": "S&P 500", "^IXIC": "Nasdaq", "^DJI": "Dow", "^RUT": "Russell 2000", "^VIX": "VIX" };
// listed tickers only: no indexes (^GSPC), futures (CL=F), FX or private companies (ANTH.PVT)
const LIVE_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;

export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function NewsFeed({
  title,
  symbols,
  pageSize = 15,
  tabs = true,
  thumbs = true,
  maxHeight,
  filterable = false,
  chip,
  scopes,
}: {
  title: string;
  /** only stories tagged with one of these tickers (undefined = every story) */
  symbols?: string[];
  pageSize?: number;
  tabs?: boolean;
  thumbs?: boolean;
  /** scroll the list inside this height (px) */
  maxHeight?: number;
  /** show a ticker filter box */
  filterable?: boolean;
  chip?: string;
  /** scope buttons (e.g. All stories / Market / Your plays); each narrows the feed to its tickers */
  scopes?: { id: string; label: string; symbols?: string[] }[];
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [tab, setTab] = useState<TabId>("all");
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState(scopes?.[0]?.id ?? "");
  const scopeSyms = scopes?.find((x) => x.id === scope)?.symbols;
  const [items, setItems] = useState<Story[]>([]);
  const [pending, setPending] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const typed = useMemo(
    () =>
      filter
        .toUpperCase()
        .split(/[\s,]+/)
        .map((s) => s.replace(/[^A-Z0-9.\-^]/g, ""))
        .filter(Boolean)
        .slice(0, 20),
    [filter]
  );
  const symKey = (typed.length ? typed : scopeSyms ?? symbols ?? []).join(",");
  const syms = useMemo(() => (symKey ? symKey.split(",") : null), [symKey]);
  const seq = useRef(0);

  const query = useCallback(
    (before?: string) => {
      let q = supabase.from("news_items").select(COLS).order("published_at", { ascending: false }).limit(pageSize);
      if (syms) q = q.overlaps("tickers", syms);
      if (tab !== "all") q = q.eq("kind", tab);
      if (before) q = q.lt("published_at", before);
      return q;
    },
    [syms, tab, pageSize]
  );

  // first page whenever the filter or tab changes
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    setPending([]);
    query().then(({ data, error }) => {
      if (my !== seq.current) return;
      setLoading(false);
      if (error) {
        setError(error.message);
        setItems([]);
        return;
      }
      const rows = (data ?? []) as Story[];
      setItems(rows);
      setMore(rows.length === pageSize);
    });
  }, [query, pageSize]);

  // new stories over Realtime
  const matches = useCallback(
    (s: Story) => (!syms || s.tickers?.some((t) => syms.includes(t))) && (tab === "all" || s.kind === tab),
    [syms, tab]
  );
  const matchRef = useRef(matches);
  matchRef.current = matches;
  useEffect(() => {
    const ch = supabase
      .channel(`news-${uid}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "news_items" }, (payload) => {
        const s = payload.new as Story;
        if (!s?.uuid || !matchRef.current(s)) return;
        // only stories newer than what's shown count as "new"
        setPending((p) => (p.some((x) => x.uuid === s.uuid) ? p : [s, ...p].slice(0, 50)));
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [uid]);

  // keep "5m ago" current
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const showPending = () => {
    setItems((cur) => {
      const seen = new Set(cur.map((x) => x.uuid));
      const add = pending.filter((x) => !seen.has(x.uuid));
      return [...add, ...cur].sort((a, b) => (a.published_at < b.published_at ? 1 : -1));
    });
    setPending([]);
  };

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    const { data, error } = await query(last.published_at);
    if (error) return setError(error.message);
    const rows = (data ?? []) as Story[];
    setItems((cur) => {
      const seen = new Set(cur.map((x) => x.uuid));
      return [...cur, ...rows.filter((r) => !seen.has(r.uuid))];
    });
    setMore(rows.length === pageSize);
  };

  const freshCount = pending.filter((p) => !items.some((x) => x.uuid === p.uuid) && (!items[0] || p.published_at >= items[0].published_at)).length;

  return (
    <Panel
      title={title}
      controls={
        <>
          {chip && <Chip>{chip}</Chip>}
          <Chip active>
            <span className="live-dot mr-1 inline-block h-1.5 w-1.5 rounded-full bg-term-green align-middle" />
            live
          </Chip>
        </>
      }
    >
      {(tabs || filterable || scopes) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-term-border px-2 py-1">
          {scopes && (
            <span className="flex gap-px" role="tablist" aria-label="Which stories">
              {scopes.map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  role="tab"
                  aria-selected={scope === sc.id && !typed.length}
                  onClick={() => {
                    setScope(sc.id);
                    setFilter("");
                  }}
                  className={`border px-2 py-0.5 text-[10.5px] font-semibold ${
                    scope === sc.id && !typed.length ? "border-term-brand bg-term-brand/15 text-term-brand" : "border-term-border text-term-dim hover:text-term-text"
                  }`}
                >
                  {sc.label}
                </button>
              ))}
            </span>
          )}
          {tabs && (
            <span className="flex gap-px" role="tablist" aria-label="Story type">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`border px-2 py-0.5 text-[10.5px] ${tab === t.id ? "border-term-borderStrong bg-term-panel2 text-term-text" : "border-term-border text-term-dim hover:text-term-text"}`}
                >
                  {t.label}
                </button>
              ))}
            </span>
          )}
          {filterable && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by tickers, e.g. NVDA AAPL"
              aria-label="Filter news by ticker"
              spellCheck={false}
              className="ml-auto w-56 border border-term-border bg-term-bg px-2 py-0.5 font-mono text-[11px] text-term-text outline-none placeholder:text-term-dim focus:border-term-brand"
            />
          )}
        </div>
      )}

      {freshCount > 0 && (
        <button
          type="button"
          onClick={showPending}
          className="news-new w-full border-b border-term-brand/50 bg-term-brand/15 px-2 py-1 text-left text-[11px] font-semibold text-term-brand hover:bg-term-brand/25"
        >
          ↑ {freshCount} new {freshCount === 1 ? "story" : "stories"} — show
        </button>
      )}

      <div style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
        {error && <div className="px-2 py-2 text-[11px] text-term-amber">News is unavailable: {error}</div>}
        {!error && loading && <div className="px-2 py-3 text-[11px] text-term-dim">Loading stories…</div>}
        {!error && !loading && items.length === 0 && (
          <div className="px-2 py-3 text-[11px] text-term-dim">
            No stories yet{syms ? ` for ${syms.map((s) => INDEX_NAMES[s] ?? s).join(", ")}` : ""}. sync-news checks every few minutes during market hours.
          </div>
        )}
        <ul className="m-0 list-none p-0">
          {items.map((s) => (
            <StoryRow key={s.uuid} s={s} now={now} thumbs={thumbs} focus={syms} />
          ))}
        </ul>
        {more && items.length > 0 && (
          <button type="button" onClick={loadMore} className="w-full border-t border-term-border px-2 py-1.5 text-[11px] text-term-cyan hover:bg-term-panel2">
            Load more
          </button>
        )}
      </div>
    </Panel>
  );
}

function StoryRow({ s, now, thumbs, focus }: { s: Story; now: number; thumbs: boolean; focus: string[] | null }) {
  // focused tickers first, then the rest; indexes only by name
  const tickers = [...(s.tickers ?? [])].sort((a, b) => Number(!!focus?.includes(b)) - Number(!!focus?.includes(a))).filter((t) => LIVE_RE.test(t)).slice(0, 4);
  return (
    <li className="row-hover flex gap-2 border-b border-term-border/60 px-2 py-1.5">
      {thumbs && s.thumb && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={s.thumb} alt="" loading="lazy" width={56} height={56} className="h-14 w-14 shrink-0 border border-term-border object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <a href={s.link} target="_blank" rel="noopener noreferrer" className="block text-[12px] font-semibold leading-snug text-term-text hover:text-term-cyan">
          {s.title}
        </a>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-term-dim">
          <span>{s.publisher ?? "—"}</span>
          <span>·</span>
          <time dateTime={s.published_at} title={new Date(s.published_at).toLocaleString()}>
            {ago(s.published_at, now)}
          </time>
          {s.kind !== "STORY" && <span className="border border-term-border px-1 text-[9px] uppercase">{s.kind === "PRESS" ? "press release" : "video"}</span>}
          {tickers.map((t) => (
            <a key={t} href={`#chart/${t}`} className="flex items-center gap-1 border border-term-border px-1 font-mono text-[10px] text-term-text hover:border-term-cyan">
              {t}
              <LivePrice symbol={t} field="change_pct" className="text-[10px]" />
            </a>
          ))}
        </div>
      </div>
    </li>
  );
}
