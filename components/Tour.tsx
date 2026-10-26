"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Guided tour of the terminal. Each step switches to its tab, scrolls its
// panel into view, dims everything else and explains what the panel shows.
// Starts from /terminal?tour=1 (the landing page's buttons) or the Tour
// button in the menu bar; Esc closes it, arrow keys step through it.

interface Step {
  tab?: string;
  target?: string; // data-tour value
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    title: "Welcome to VIBA Terminal",
    body: "This tour walks through the terminal one panel at a time and takes about two minutes. Use Next and Back, or the arrow keys. You can close it at any point and restart it from Tour in the menu bar.",
  },
  {
    target: "tabs",
    title: "Five sections, in the order you'd use them",
    body: "Overview tells you the market's mood, Plays gives you stocks that fit it, Smart Money and Predictive Plays add evidence, and Chart & News lets you check any ticker before you act. The terminal remembers the last tab you used.",
  },
  {
    tab: "overview",
    target: "quotes",
    title: "Live prices and the regime score",
    body: "SPY, QQQ and IWM update about every 30 seconds from 4am to 8pm Eastern, flashing green or red when they move. Under each price is its regime score: above +0.4 is risk-on, between −0.4 and +0.4 is neutral, below −0.4 is caution.",
  },
  {
    tab: "overview",
    target: "legs",
    title: "What's driving the score",
    body: "The score blends five readings: trend, breadth, volatility, credit and the rate curve. Each is shown against its own last year, so you can see which one is pulling the score up or down.",
  },
  {
    tab: "overview",
    target: "sectors",
    title: "Which sectors are leading",
    body: "The 11 sectors ranked by momentum per unit of risk. Plays come from the top three, so when the leaders change, the plays change with them.",
  },
  {
    tab: "plays",
    target: "plays",
    title: "Plays with a plan",
    body: "Each play has the case for it and a plan built from its own chart: where to enter, where the stop goes, two targets, and the reward-to-risk. The watchlist underneath holds the next names in line.",
  },
  {
    tab: "smart",
    target: "smart",
    title: "Where big money leans",
    body: "Money flow by sector, options positioning, insider buying, hedge-fund moves and congressional trades. Use it as supporting evidence for a play rather than a signal on its own.",
  },
  {
    tab: "predictive",
    target: "predictive",
    title: "Customers before earnings",
    body: "Companies whose App Store and Steam reviews sound unusually upbeat (tailwind) or unhappy (headwind) ahead of their next report, with the quotes behind each call and a running track record.",
  },
  {
    tab: "chart",
    target: "search",
    title: "Chart any ticker",
    body: "Type a ticker or a company name and press Analyze. Clicking a ticker anywhere in the terminal, in a play or a news story, also brings it here.",
  },
  {
    tab: "chart",
    target: "ranges",
    title: "Pick a time frame",
    body: "1D shows 1-minute bars including pre-market and after-hours, 5D and 1M step up to 5- and 30-minute bars, and 3M to All show daily bars. The Interval menu lets you choose any bar size yourself.",
  },
  {
    tab: "chart",
    target: "indicators",
    title: "Add indicators",
    body: "Open Indicators to add any of 24 studies: 15 kinds of moving average, Bollinger bands, Parabolic SAR, VWAP, RSI, MACD and more. Click a chip to change its settings, × to remove it. Your choices are saved for next time.",
  },
  {
    tab: "chart",
    target: "chart",
    title: "Levels and the trade plan on the chart",
    body: "Dashed lines mark support and resistance found in the price history; solid lines show the setup's entry, stop and targets. The last candle moves with the live price.",
  },
  {
    tab: "chart",
    target: "news",
    title: "News as it breaks",
    body: "Stories for the ticker you're charting, everything, the market, or your plays. New stories announce themselves at the top, and each one shows the tickers it mentions with their live change.",
  },
  {
    target: "status",
    title: "Is everything live?",
    body: "QUOTES LIVE means prices are streaming; RT LIVE means the rest of the terminal refreshes itself when new data lands. If a data source fails, the SUPABASE badge turns red and names it.",
  },
  {
    tab: "overview",
    title: "You're set",
    body: "A good routine: check the regime on Overview, look at today's plays, then confirm one on Chart & News before you trade. Nothing here is financial advice; every number is explained where it appears.",
  },
];

const DONE_KEY = "viba-tour-done";
const PAD = 6;

function currentTab() {
  return window.location.hash.replace(/^#/, "").split("/")[0];
}

export function startTour() {
  window.dispatchEvent(new Event("viba-tour-start"));
}

export default function Tour() {
  const [i, setI] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);

  // start from ?tour=1 or the menu-bar button
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tour") === "1") {
      url.searchParams.delete("tour");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
      setI(0);
    }
    const onStart = () => setI(0);
    window.addEventListener("viba-tour-start", onStart);
    return () => window.removeEventListener("viba-tour-start", onStart);
  }, []);

  const close = useCallback((finished: boolean) => {
    setI(null);
    setRect(null);
    targetRef.current = null;
    if (finished) {
      try {
        localStorage.setItem(DONE_KEY, "1");
      } catch {}
    }
  }, []);

  // go to the step's tab and find its panel
  useEffect(() => {
    if (i === null) return;
    const step = STEPS[i];
    if (step.tab && currentTab() !== step.tab) window.location.hash = `#${step.tab}`;
    setRect(null);
    targetRef.current = null;
    if (!step.target) return;
    let cancelled = false;
    const t0 = performance.now();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const seek = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (el && el.offsetParent !== null && el.getBoundingClientRect().height > 0) {
        targetRef.current = el;
        el.scrollIntoView({ block: el.getBoundingClientRect().height > window.innerHeight * 0.6 ? "start" : "center", behavior: reduce ? "auto" : "smooth" });
        setTimeout(() => !cancelled && setRect(el.getBoundingClientRect()), reduce ? 0 : 420);
        return;
      }
      if (performance.now() - t0 < 4000) requestAnimationFrame(seek);
    };
    requestAnimationFrame(seek);
    return () => {
      cancelled = true;
    };
  }, [i]);

  // follow the panel while the page scrolls or resizes
  useEffect(() => {
    if (i === null) return;
    const update = () => targetRef.current && setRect(targetRef.current.getBoundingClientRect());
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [i]);

  // place the card below the panel, or above it, or over it when neither fits
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (i === null || !card) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    if (!rect || vw < 640) {
      setCardPos(null); // centered (desktop) or bottom sheet (phone), set in CSS
      return;
    }
    const left = Math.min(Math.max(12, rect.left), vw - cw - 12);
    let top: number;
    if (rect.bottom + PAD + 12 + ch < vh) top = rect.bottom + PAD + 12;
    else if (rect.top - PAD - 12 - ch > 0) top = rect.top - PAD - 12 - ch;
    else top = Math.max(12, vh - ch - 16);
    setCardPos({ top, left });
  }, [rect, i]);

  // keyboard
  useEffect(() => {
    if (i === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "ArrowRight") setI((n) => (n === null ? n : Math.min(STEPS.length - 1, n + 1)));
      else if (e.key === "ArrowLeft") setI((n) => (n === null ? n : Math.max(0, n - 1)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, close]);

  // move focus to the card so screen readers announce each step
  useEffect(() => {
    if (i !== null) cardRef.current?.focus({ preventScroll: true });
  }, [i]);

  if (i === null) return null;
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[60]" style={{ pointerEvents: "none" }}>
      {rect ? (
        <div
          aria-hidden
          className="absolute rounded-[6px] transition-all duration-300 ease-out motion-reduce:transition-none"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 2px #6cb33f, 0 0 0 9999px rgba(0,0,0,0.66)",
          }}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-black/65" />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        className={`pointer-events-auto absolute w-[min(380px,calc(100vw-24px))] border border-term-borderStrong bg-term-panel p-3 shadow-2xl outline-none ${
          cardPos ? "" : "max-sm:bottom-3 max-sm:left-3 max-sm:right-3 max-sm:w-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2"
        }`}
        style={cardPos ? { top: cardPos.top, left: cardPos.left } : undefined}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[10.5px] text-term-dim">
            Step {i + 1} of {STEPS.length}
          </span>
          <button type="button" onClick={() => close(false)} className="text-[11px] text-term-dim hover:text-term-text" aria-label="Close the tour">
            ✕
          </button>
        </div>
        <div className="mb-2 h-[3px] w-full bg-term-panel2">
          <div className="h-full bg-term-brand transition-[width] duration-300" style={{ width: `${((i + 1) / STEPS.length) * 100}%` }} />
        </div>
        <h2 id="tour-title" className="m-0 mb-1 text-[14px] font-bold text-term-text">
          {step.title}
        </h2>
        <p id="tour-body" className="m-0 text-[12.5px] leading-relaxed text-term-text/90">
          {step.body}
        </p>
        <div className="mt-3 flex items-center gap-2">
          {i > 0 && (
            <button type="button" onClick={() => setI(i - 1)} className="border border-term-border px-3 py-1 text-[11.5px] text-term-text hover:border-term-borderStrong">
              Back
            </button>
          )}
          {!last && (
            <button type="button" onClick={() => close(true)} className="px-1 text-[11px] text-term-dim hover:text-term-text">
              Skip tour
            </button>
          )}
          <button
            type="button"
            onClick={() => (last ? close(true) : setI(i + 1))}
            className="ml-auto border border-term-brand bg-term-brand/20 px-3 py-1 text-[11.5px] font-semibold text-term-brand hover:bg-term-brand/30"
            autoFocus
          >
            {last ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Tour" in the menu bar. */
export function TourButton() {
  return (
    <button type="button" onClick={startTour} className="border border-term-border px-1.5 text-[10.5px] text-term-text hover:border-term-brand hover:text-term-brand" title="Take the guided tour">
      Tour
    </button>
  );
}
