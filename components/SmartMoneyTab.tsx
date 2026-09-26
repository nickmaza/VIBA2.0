"use client";

import type { AssetFlow, SmartMoneyPayload } from "@/lib/smartmoney";
import type { InsiderSummary } from "@/lib/smartmoney/sec";
import Panel, { Chip } from "@/components/Panel";
import { useFunds, useInsiders, useSmartMoney } from "@/components/useSmartMoney";
import { scoreTone } from "@/components/SmartMoneyPlays";

const fmtBig = (x: number) =>
  Math.abs(x) >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : Math.abs(x) >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : Math.abs(x) >= 1e3 ? `$${(x / 1e3).toFixed(0)}K` : `$${x.toFixed(0)}`;
const pct = (v: number | null, d = 1) => (v === null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const tone = (v: number | null) => (v === null ? "text-term-dim" : v > 0 ? "text-term-green" : v < 0 ? "text-term-red" : "text-term-text");
const QUAD_TONE: Record<string, string> = {
  Leading: "text-term-green border-term-green/50",
  Improving: "text-term-cyan border-term-cyan/50",
  Weakening: "text-term-yellow border-term-yellow/50",
  Lagging: "text-term-red border-term-red/50",
};

/** Diverging bar: flow score 0..100 around 50. */
function FlowBar({ score }: { score: number }) {
  const d = score - 50;
  const w = Math.min(50, Math.abs(d));
  return (
    <span className="relative block h-2.5 w-full bg-term-panel2" title={`Flow score ${score}`}>
      <span className="absolute inset-y-0 left-1/2 w-px bg-term-borderStrong" />
      <span
        className={`absolute inset-y-0 ${d >= 0 ? "bg-term-green/80" : "bg-term-red/80"}`}
        style={d >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
      />
    </span>
  );
}

function Loading({ what }: { what: string }) {
  return <div className="px-2 py-3 text-[11.5px] text-term-dim">Loading {what}…</div>;
}

/** Relative-rotation style map: x = 3-month strength vs SPY, y = 1-month strength vs SPY. Dot color = flow. */
function RotationMap({ assets }: { assets: AssetFlow[] }) {
  const pts = assets.filter((a) => a.rs1m !== null && a.rs3m !== null);
  if (!pts.length) return null;
  const W = 560, H = 330, M = { l: 36, r: 14, t: 14, b: 26 };
  const xs = pts.map((p) => p.rs3m as number), ys = pts.map((p) => p.rs1m as number);
  const xr = Math.max(5, ...xs.map(Math.abs)) * 1.12, yr = Math.max(4, ...ys.map(Math.abs)) * 1.15;
  const X = (v: number) => M.l + ((v + xr) / (2 * xr)) * (W - M.l - M.r);
  const Y = (v: number) => M.t + ((yr - v) / (2 * yr)) * (H - M.t - M.b);
  const col = (s: number) => (s >= 57 ? "#3fbf4a" : s <= 43 ? "#e5453c" : "#f5d033");
  const tickStep = (r: number) => (r > 30 ? 20 : r > 15 ? 10 : 5);
  const tx: number[] = [], ty: number[] = [];
  for (let v = -Math.floor(xr / tickStep(xr)) * tickStep(xr); v <= xr; v += tickStep(xr)) tx.push(v);
  for (let v = -Math.floor(yr / tickStep(yr)) * tickStep(yr); v <= yr; v += tickStep(yr)) ty.push(v);
  // nudge labels apart so a tight cluster stays readable
  const placed: { x: number; y: number }[] = [];
  const labels = [...pts]
    .sort((a, b) => (b.rs1m as number) - (a.rs1m as number))
    .map((p) => {
      const lx = X(p.rs3m as number) + 6;
      let ly = Y(p.rs1m as number) + 3;
      for (let guard = 0; guard < 12 && placed.some((q) => Math.abs(q.x - lx) < 30 && Math.abs(q.y - ly) < 10); guard++) ly += 10;
      placed.push({ x: lx, y: ly });
      return { p, lx, ly };
    });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Rotation map of sectors and asset classes">
      <rect x={X(0)} y={M.t} width={X(xr) - X(0)} height={Y(0) - M.t} fill="#3fbf4a" opacity={0.05} />
      <rect x={M.l} y={M.t} width={X(0) - M.l} height={Y(0) - M.t} fill="#4fb3e8" opacity={0.05} />
      <rect x={X(0)} y={Y(0)} width={X(xr) - X(0)} height={H - M.b - Y(0)} fill="#f5d033" opacity={0.05} />
      <rect x={M.l} y={Y(0)} width={X(0) - M.l} height={H - M.b - Y(0)} fill="#e5453c" opacity={0.05} />
      {tx.map((v) => (
        <g key={`x${v}`}>
          <line x1={X(v)} x2={X(v)} y1={M.t} y2={H - M.b} stroke={v === 0 ? "#5a5a5a" : "#262626"} />
          <text x={X(v)} y={H - 9} fontSize={9.5} fill="#9c9c9c" textAnchor="middle" fontFamily="monospace">
            {v > 0 ? `+${v}` : v}
          </text>
        </g>
      ))}
      {ty.map((v) => (
        <g key={`y${v}`}>
          <line x1={M.l} x2={W - M.r} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? "#5a5a5a" : "#262626"} />
          <text x={M.l - 5} y={Y(v) + 3} fontSize={9.5} fill="#9c9c9c" textAnchor="end" fontFamily="monospace">
            {v > 0 ? `+${v}` : v}
          </text>
        </g>
      ))}
      <text x={W - M.r - 4} y={M.t + 12} fontSize={10} fill="#3fbf4a" textAnchor="end">LEADING</text>
      <text x={M.l + 4} y={M.t + 12} fontSize={10} fill="#4fb3e8">IMPROVING</text>
      <text x={W - M.r - 4} y={H - M.b - 6} fontSize={10} fill="#f5d033" textAnchor="end">WEAKENING</text>
      <text x={M.l + 4} y={H - M.b - 6} fontSize={10} fill="#e5453c">LAGGING</text>
      {labels.map(({ p, lx, ly }) => (
        <g key={p.symbol}>
          <circle cx={X(p.rs3m as number)} cy={Y(p.rs1m as number)} r={4.5} fill={col(p.flow.score)} stroke="#0b0b0b" strokeWidth={1}>
            <title>{`${p.symbol} ${p.name}: 3M ${pct(p.rs3m)} vs SPY, 1M ${pct(p.rs1m)} vs SPY, flow ${p.flow.score} (${p.flow.label})`}</title>
          </circle>
          {ly !== Y(p.rs1m as number) + 3 && (
            <line x1={X(p.rs3m as number) + 4} y1={Y(p.rs1m as number)} x2={lx - 1} y2={ly - 3} stroke="#5a5a5a" strokeWidth={0.6} />
          )}
          <text x={lx} y={ly} fontSize={9.5} fill="#e6e6e6" fontFamily="monospace">
            {p.symbol}
          </text>
        </g>
      ))}
    </svg>
  );
}

function AssetTable({ assets }: { assets: AssetFlow[] }) {
  const groups = Array.from(new Set(assets.map((a) => a.group)));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase text-term-dim">
            <th className="px-2 py-1 font-normal">Asset</th>
            <th className="w-[26%] px-2 py-1 font-normal">Flow (out ← → in)</th>
            <th className="px-2 py-1 font-normal">Read</th>
            <th className="px-2 py-1 text-right font-normal">CMF</th>
            <th className="px-2 py-1 text-right font-normal">RVOL 5d</th>
            <th className="px-2 py-1 text-right font-normal">1M vs SPY</th>
            <th className="px-2 py-1 text-right font-normal">3M vs SPY</th>
            <th className="px-2 py-1 font-normal">Rotation</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => [
            <tr key={g} className="bg-term-panel2">
              <td colSpan={8} className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-term-amber">
                {g}
              </td>
            </tr>,
            ...assets
              .filter((a) => a.group === g)
              .sort((a, b) => b.flow.score - a.flow.score)
              .map((a) => (
                <tr key={a.symbol} className="row-hover border-t border-term-border/60">
                  <td className="px-2 py-1">
                    <a href={`#chart/${a.symbol}`} className="font-mono font-bold text-term-text hover:text-term-cyan">
                      {a.symbol}
                    </a>{" "}
                    <span className="text-term-dim">{a.name}</span>
                  </td>
                  <td className="px-2 py-1">
                    <FlowBar score={a.flow.score} />
                  </td>
                  <td className={`whitespace-nowrap px-2 py-1 ${a.flow.score >= 57 ? "text-term-green" : a.flow.score <= 43 ? "text-term-red" : "text-term-yellow"}`}>
                    {a.flow.label}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono tabular-nums ${tone(a.flow.cmf)}`}>
                    {a.flow.cmf >= 0 ? "+" : ""}
                    {a.flow.cmf.toFixed(2)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{a.flow.relVol5.toFixed(1)}×</td>
                  <td className={`px-2 py-1 text-right font-mono tabular-nums ${tone(a.rs1m)}`}>{pct(a.rs1m)}</td>
                  <td className={`px-2 py-1 text-right font-mono tabular-nums ${tone(a.rs3m)}`}>{pct(a.rs3m)}</td>
                  <td className="px-2 py-1">
                    {a.quadrant && <span className={`border px-1 text-[10px] font-semibold uppercase ${QUAD_TONE[a.quadrant]}`}>{a.quadrant}</span>}
                  </td>
                </tr>
              )),
          ])}
        </tbody>
      </table>
    </div>
  );
}

function RiskPairs({ d }: { d: SmartMoneyPayload }) {
  const max = Math.max(2, ...d.riskPairs.map((r) => Math.abs(r.change ?? 0)));
  return (
    <div className="text-[11px]">
      {d.riskPairs.map((r) => {
        const w = r.change === null ? 0 : (Math.abs(r.change) / max) * 50;
        return (
          <div key={r.pair} className="grid grid-cols-[minmax(0,1.3fr)_minmax(90px,1fr)_56px] items-center gap-2 border-t border-term-border/60 px-2 py-1.5 first:border-t-0">
            <span className="min-w-0">
              <span className="block text-term-text">{r.label}</span>
              <span className="block truncate text-[10px] text-term-dim">
                {r.pair} · {r.read}
              </span>
            </span>
            <span className="relative block h-2.5 bg-term-panel2">
              <span className="absolute inset-y-0 left-1/2 w-px bg-term-borderStrong" />
              <span
                className={`absolute inset-y-0 ${(r.change ?? 0) >= 0 ? "bg-term-green/80" : "bg-term-red/80"}`}
                style={(r.change ?? 0) >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
              />
            </span>
            <span className={`text-right font-mono tabular-nums ${tone(r.change)}`}>{pct(r.change)}</span>
          </div>
        );
      })}
      <div className="border-t border-term-border px-2 py-1.5 text-[10.5px] text-term-dim">
        {d.riskOnCount} of {d.riskPairs.filter((r) => r.riskOn !== null).length} pairs risk-on over 20 sessions. {d.riskRead}
      </div>
    </div>
  );
}

function OptionsTables({ d }: { d: SmartMoneyPayload }) {
  const m = d.optionsMarket;
  const callShare = m.callPremium + m.putPremium > 0 ? (m.callPremium / (m.callPremium + m.putPremium)) * 100 : 50;
  return (
    <div className="text-[11px]">
      <div className="flex flex-wrap items-center gap-3 border-b border-term-border px-2 py-2">
        <span className="font-mono text-[18px] font-bold text-term-text">{m.ratio.toFixed(2)}×</span>
        <span className="text-term-dim">
          call vs put premium across {m.names} most active large caps · {fmtBig(m.callPremium)} calls / {fmtBig(m.putPremium)} puts
        </span>
        <span className="relative block h-2 w-full bg-term-red/60">
          <span className="absolute inset-y-0 left-0 bg-term-green/80" style={{ width: `${callShare}%` }} />
        </span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="overflow-x-auto">
          <div className="px-2 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-term-green">Bullish positioning</div>
          <table className="w-full min-w-[520px] border-collapse">
            <thead>
              <tr className="text-left text-[10px] uppercase text-term-dim">
                <th className="px-2 py-1 font-normal">Symbol</th>
                <th className="px-2 py-1 text-right font-normal">Call $</th>
                <th className="px-2 py-1 text-right font-normal">Put $</th>
                <th className="px-2 py-1 text-right font-normal">Skew</th>
                <th className="px-2 py-1 text-right font-normal">Call vol vs 10d</th>
                <th className="px-2 py-1 font-normal">Read</th>
              </tr>
            </thead>
            <tbody>
              {d.optionsLeaders.map((o) => (
                <tr key={o.symbol} className="row-hover border-t border-term-border/60">
                  <td className="px-2 py-1">
                    <a href={`#chart/${o.symbol}`} className="font-mono font-bold text-term-text hover:text-term-cyan">
                      {o.symbol}
                    </a>
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-term-green">{fmtBig(o.callPremium)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-term-red">{fmtBig(o.putPremium)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{o.read.skew.toFixed(1)}×</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{o.read.callVolRatio.toFixed(1)}×</td>
                  <td className="whitespace-nowrap px-2 py-1 text-term-dim">{o.read.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto border-t border-term-border xl:border-l xl:border-t-0">
          <div className="px-2 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-term-red">Put-heavy (hedging or bearish)</div>
          <table className="w-full min-w-[300px] border-collapse">
            <thead>
              <tr className="text-left text-[10px] uppercase text-term-dim">
                <th className="px-2 py-1 font-normal">Symbol</th>
                <th className="px-2 py-1 text-right font-normal">Put $</th>
                <th className="px-2 py-1 text-right font-normal">Call $</th>
                <th className="px-2 py-1 text-right font-normal">Puts/Calls</th>
              </tr>
            </thead>
            <tbody>
              {d.putHeavy.map((o) => (
                <tr key={o.symbol} className="row-hover border-t border-term-border/60">
                  <td className="px-2 py-1">
                    <a href={`#chart/${o.symbol}`} className="font-mono font-bold text-term-text hover:text-term-cyan">
                      {o.symbol}
                    </a>
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-term-red">{fmtBig(o.putPremium)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-term-green">{fmtBig(o.callPremium)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{(o.putPremium / Math.max(1, o.callPremium)).toFixed(1)}×</td>
                </tr>
              ))}
              {d.putHeavy.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-2 py-2 text-term-dim">No large cap traded more put premium than call premium.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StockFlows({ d }: { d: SmartMoneyPayload }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase text-term-dim">
            <th className="px-2 py-1 font-normal">Symbol</th>
            <th className="px-2 py-1 font-normal">SM score</th>
            <th className="w-[22%] px-2 py-1 font-normal">Volume flow</th>
            <th className="px-2 py-1 font-normal">Flow read</th>
            <th className="px-2 py-1 font-normal">Options</th>
            <th className="px-2 py-1 text-right font-normal">Acc / Dist days</th>
            <th className="px-2 py-1 text-right font-normal">1M</th>
          </tr>
        </thead>
        <tbody>
          {d.stockFlows.map((s) => (
            <tr key={s.symbol} className="row-hover border-t border-term-border/60">
              <td className="px-2 py-1">
                <a href={`#chart/${s.symbol}`} className="font-mono font-bold text-term-text hover:text-term-cyan">
                  {s.symbol}
                </a>{" "}
                <span className="text-term-dim">{s.name.slice(0, 22)}</span>
              </td>
              <td className="px-2 py-1">
                <span className={`border px-1 font-mono text-[10px] ${scoreTone(s.score)}`}>{s.score}</span>
              </td>
              <td className="px-2 py-1">
                <FlowBar score={s.flow.score} />
              </td>
              <td className={`whitespace-nowrap px-2 py-1 ${s.flow.score >= 57 ? "text-term-green" : s.flow.score <= 43 ? "text-term-red" : "text-term-yellow"}`}>
                {s.flow.label}
              </td>
              <td className="whitespace-nowrap px-2 py-1 text-term-dim">{s.options ? `${s.options.label} (${s.options.skew.toFixed(1)}×)` : "—"}</td>
              <td className="px-2 py-1 text-right font-mono tabular-nums">
                <span className="text-term-green">{s.flow.accDays}</span> / <span className="text-term-red">{s.flow.distDays}</span>
              </td>
              <td className={`px-2 py-1 text-right font-mono tabular-nums ${tone(s.flow.r1m)}`}>{pct(s.flow.r1m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Insiders({ symbols }: { symbols: string[] }) {
  const { data, error, loading } = useInsiders(symbols);
  if (loading) return <Loading what="SEC Form 4 insider filings" />;
  if (error || !data) return <div className="px-2 py-2 text-[11px] text-term-dim">SEC EDGAR didn&apos;t respond{error ? `: ${error}` : ""}. Insider data will retry on the next visit.</div>;
  const rows = data.results as InsiderSummary[];
  const buys = rows.flatMap((r) => (r.buys ?? []).map((b) => ({ ...b, symbol: r.symbol }))).sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div className="text-[11px]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse">
          <thead>
            <tr className="text-left text-[10px] uppercase text-term-dim">
              <th className="px-2 py-1 font-normal">Symbol</th>
              <th className="px-2 py-1 text-right font-normal">Open-market buys</th>
              <th className="px-2 py-1 text-right font-normal">Bought</th>
              <th className="px-2 py-1 text-right font-normal">Sales</th>
              <th className="px-2 py-1 text-right font-normal">Sold</th>
              <th className="px-2 py-1 font-normal">Read</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="row-hover border-t border-term-border/60">
                <td className="px-2 py-1 font-mono font-bold">{r.symbol}</td>
                {r.error ? (
                  <td colSpan={5} className="px-2 py-1 text-term-dim">{r.error}</td>
                ) : (
                  <>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-term-green">{r.buys.length}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-term-green">{r.buyValue ? fmtBig(r.buyValue) : "—"}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-term-red">{r.sells.length}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-term-red">{r.sellValue ? fmtBig(r.sellValue) : "—"}</td>
                    <td className="px-2 py-1 text-term-dim">
                      {r.buys.length > 0 ? "Insiders buying with their own money" : r.sells.length > 0 ? "Selling only (often planned 10b5-1 sales)" : "Quiet"}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {buys.length > 0 && (
        <div className="border-t border-term-border">
          <div className="px-2 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-term-green">Recent open-market purchases</div>
          <table className="w-full border-collapse">
            <tbody>
              {buys.slice(0, 12).map((b, i) => (
                <tr key={i} className="border-t border-term-border/60">
                  <td className="px-2 py-1 font-mono font-bold">{b.symbol}</td>
                  <td className="px-2 py-1">{b.name}</td>
                  <td className="px-2 py-1 text-term-dim">{b.role}</td>
                  <td className="px-2 py-1 font-mono text-term-dim">{b.date}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-term-green">{fmtBig(b.value)}</td>
                  <td className="px-2 py-1 text-right">
                    <a href={b.url} target="_blank" rel="noreferrer" className="text-term-cyan hover:underline">
                      Form 4 →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="border-t border-term-border px-2 py-1.5 text-[10px] text-term-dim">
        Last 90 days of SEC Form 4 filings. Only open-market purchases (code P) and sales (code S) count; option exercises,
        grants and gifts are ignored.
      </div>
    </div>
  );
}

function Funds() {
  const { data, error, loading } = useFunds();
  if (loading) return <Loading what="13F filings from SEC EDGAR" />;
  if (error || !data) return <div className="px-2 py-2 text-[11px] text-term-dim">SEC EDGAR didn&apos;t respond{error ? `: ${error}` : ""}. Fund data will retry on the next visit.</div>;
  if (data.funds.length === 0) return <div className="px-2 py-2 text-[11px] text-term-dim">No 13F filings could be read right now. {data.errors.join(" · ")}</div>;
  return (
    <div className="text-[11px]">
      {data.consensus.length > 0 && (
        <div className="overflow-x-auto">
          <div className="px-2 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-term-amber">Where tracked funds agree</div>
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="text-left text-[10px] uppercase text-term-dim">
                <th className="px-2 py-1 font-normal">Stock</th>
                <th className="px-2 py-1 font-normal">Bought / added by</th>
                <th className="px-2 py-1 font-normal">Sold / trimmed by</th>
                <th className="px-2 py-1 text-right font-normal">Net $</th>
              </tr>
            </thead>
            <tbody>
              {data.consensus.map((c) => (
                <tr key={c.issuer} className="row-hover border-t border-term-border/60">
                  <td className="px-2 py-1">
                    {c.ticker ? (
                      <a href={`#chart/${c.ticker}`} className="font-mono font-bold text-term-text hover:text-term-cyan">
                        {c.ticker}
                      </a>
                    ) : null}{" "}
                    <span className="text-term-dim">{c.issuer}</span>
                  </td>
                  <td className="px-2 py-1 text-term-green">{c.buyers.join(", ") || "—"}</td>
                  <td className="px-2 py-1 text-term-red">{c.sellers.join(", ") || "—"}</td>
                  <td className={`px-2 py-1 text-right font-mono tabular-nums ${tone(c.netValue)}`}>{fmtBig(c.netValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="grid grid-cols-1 gap-px border-t border-term-border bg-term-border md:grid-cols-2 2xl:grid-cols-3">
        {data.funds.map((f) => (
          <div key={f.fund} className="bg-term-panel p-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-term-text">{f.fund}</span>
              <span className="text-[10px] text-term-dim">Q ending {f.period} · filed {f.filed}</span>
            </div>
            <div className="text-[10.5px] text-term-dim">
              {f.manager ? `${f.manager} · ` : ""}
              {f.positions} positions · {fmtBig(f.totalValue)}
            </div>
            <div className="mt-1 text-[10.5px] text-term-dim">
              Top: {f.top.map((t) => `${t.ticker ?? t.issuer} ${t.pct.toFixed(0)}%`).join(", ")}
            </div>
            <ul className="m-0 mt-1.5 list-none p-0">
              {f.moves.slice(0, 6).map((m, i) => (
                <li key={i} className="flex justify-between gap-2 border-t border-term-border/50 py-0.5">
                  <span className="min-w-0 truncate">
                    <span
                      className={`mr-1 inline-block w-[52px] text-[10px] font-semibold uppercase ${
                        m.action === "New" || m.action === "Added" ? "text-term-green" : "text-term-red"
                      }`}
                    >
                      {m.action}
                    </span>
                    <span className="font-mono text-term-text">{m.ticker ?? ""}</span> <span className="text-term-dim">{m.issuer}</span>
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-term-dim">
                    {m.sharesChangePct !== null && m.action !== "Exited" ? pct(m.sharesChangePct, 0) + " · " : ""}
                    {fmtBig(m.value)}
                  </span>
                </li>
              ))}
              {f.moves.length === 0 && <li className="py-0.5 text-term-dim">No changes of 10% or more vs the prior quarter.</li>}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-term-border px-2 py-1.5 text-[10px] text-term-dim">
        13F filings show US stock holdings at quarter end and are due 45 days later, so they describe positioning up to
        ~4 months old. Changes of 10% or more in share count count as added or trimmed. Options positions are excluded.
        {data.errors.length > 0 && ` Unavailable: ${data.errors.join("; ")}.`}
      </div>
    </div>
  );
}

function Congress({ d }: { d: SmartMoneyPayload }) {
  const rows = d.congress.filter((c) => c.trades.length > 0).sort((a, b) => b.buys - b.sells - (a.buys - a.sells));
  const recent = d.congress.flatMap((c) => c.trades.map((t) => ({ ...t, symbol: c.symbol }))).sort((a, b) => b.disclosed.localeCompare(a.disclosed));
  return (
    <div className="text-[11px]">
      <div className="flex flex-wrap gap-1.5 px-2 py-2">
        {rows.map((c) => (
          <span key={c.symbol} className="border border-term-border px-1.5 py-0.5">
            <span className="font-mono font-bold">{c.symbol}</span> <span className="text-term-green">{c.buys}B</span> /{" "}
            <span className="text-term-red">{c.sells}S</span>
          </span>
        ))}
      </div>
      <div className="max-h-[260px] overflow-auto border-t border-term-border">
        <table className="w-full min-w-[560px] border-collapse">
          <tbody>
            {recent.slice(0, 30).map((t, i) => (
              <tr key={i} className="border-t border-term-border/60">
                <td className="px-2 py-1 font-mono font-bold">{t.symbol}</td>
                <td className={`px-2 py-1 font-semibold ${t.side === "BUY" ? "text-term-green" : "text-term-red"}`}>{t.side}</td>
                <td className="px-2 py-1">{t.politician}</td>
                <td className="px-2 py-1 text-term-dim">{t.party}</td>
                <td className="px-2 py-1 font-mono text-term-dim">{t.amount}</td>
                <td className="px-2 py-1 font-mono text-term-dim">traded {t.traded}</td>
                <td className="px-2 py-1 font-mono text-term-dim">disclosed {t.disclosed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-term-border px-2 py-1.5 text-[10px] text-term-dim">
        Source: Tip Ranks STOCK Act disclosures (via Robinhood), last {d.congressWindowDays} days, feed as of {d.feedAsOf}. Amounts are
        disclosed ranges and trades are reported up to 45 days late, so treat this as history, not a live signal.
      </div>
    </div>
  );
}

/** The Smart Money tab: where money is moving and how the big players are positioned. */
export default function SmartMoneyTab() {
  const { data: d, error, loading } = useSmartMoney();
  if (loading) return <Panel title="Smart Money"><Loading what="money flow across 27 asset classes and the most active large caps" /></Panel>;
  if (error || !d) return <Panel title="Smart Money"><div className="px-2 py-3 text-[11.5px] text-term-red">Smart money data didn&apos;t load{error ? `: ${error}` : ""}.</div></Panel>;
  const insiderSymbols = Array.from(new Set([...d.plays.map((p) => p.symbol), ...d.stockFlows.slice(0, 10).map((s) => s.symbol)])).slice(0, 10);
  return (
    <div className="flex flex-col gap-[3px]">
      <Panel
        title="Where the money is moving"
        controls={
          <>
            <Chip active>bars {d.barsAsOf}</Chip>
            <Chip>feed {d.feedAsOf}</Chip>
          </>
        }
        bodyClassName="p-2"
      >
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] leading-relaxed">
          {d.headline.map((h, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-term-brand">▸</span>
              <span className="text-term-text">{h}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="grid grid-cols-1 gap-[3px] xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Panel title="Money flow by sector & asset class" controls={<Chip>{d.assets.length} ETFs</Chip>}>
          <AssetTable assets={d.assets} />
          <div className="border-t border-term-border px-2 py-1.5 text-[10px] leading-relaxed text-term-dim">
            Flow blends Chaikin money flow, on-balance volume, up/down volume and accumulation vs distribution days over the
            last 20-25 sessions (50 = neutral). Rotation compares 1- and 3-month returns with SPY.
          </div>
        </Panel>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <Panel title="Rotation map" controls={<Chip>vs SPY</Chip>} bodyClassName="p-2">
            <RotationMap assets={d.assets} />
            <div className="text-[10px] text-term-dim">
              Right = stronger than SPY over 3 months, up = stronger over 1 month. Green dots are under accumulation, red under
              distribution.
            </div>
          </Panel>
          <Panel title="Risk appetite" controls={<Chip active>{d.riskOnCount}/{d.riskPairs.length} risk-on</Chip>}>
            <RiskPairs d={d} />
          </Panel>
        </div>
      </div>

      <Panel title="Options positioning" controls={<Chip>premium traded · feed {d.feedAsOf}</Chip>}>
        <OptionsTables d={d} />
      </Panel>

      <div className="grid grid-cols-1 gap-[3px] xl:grid-cols-2">
        <Panel title="Accumulation leaders (stocks)" controls={<Chip>volume + options</Chip>}>
          <StockFlows d={d} />
        </Panel>
        <Panel title="Insider buying (SEC Form 4)" controls={<Chip>90 days</Chip>}>
          <Insiders symbols={insiderSymbols} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-[3px] xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title="Hedge fund positioning (13F)" controls={<Chip>tracked funds</Chip>}>
          <Funds />
        </Panel>
        <Panel title="Congressional trades" controls={<Chip>STOCK Act</Chip>}>
          <Congress d={d} />
        </Panel>
      </div>

      <footer className="px-1 pb-1 text-[10px] leading-relaxed text-term-dim">
        <span className="font-semibold text-term-text">How to use this.</span> None of these signals is proof on its own:
        volume can come from index rebalancing, call buying can be hedging, insiders sell for personal reasons, and 13F and
        congressional data arrive weeks late. The useful read is agreement, when several independent signals point the same
        way. Sources: price and volume ({d.sources.bars}), {d.sources.options}, {d.sources.congress}, SEC EDGAR.
      </footer>
    </div>
  );
}
