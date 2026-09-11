#!/usr/bin/env python3
"""
Regime & Sector Rotation Terminal -- refresh job.

This is the computational half of the "keeps up with the market" pipeline.
It does NOT fetch market data itself (a plain script has no Robinhood
session) -- it expects the calling agent to have already pulled fresh daily
OHLCV CSVs into ./data/<SYMBOL>.csv (same shape load_data.py always wrote:
date,open,high,low,close,volume,interpolated), then computes the regime
score + sector ranking as of the latest date and upserts the results into
Supabase via its REST API using the service-role key.

Env vars required:
  SUPABASE_URL                e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY   service role key (server-side only, never ship
                              this to the browser / commit it to git)

Usage:
  python3 scripts/refresh.py
"""
import os
import sys
import json
import numpy as np
import pandas as pd
import requests

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
ROLL = 252

SECTORS = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE", "XLC"]
SECTOR_NAMES = {
    "XLK": "Technology", "XLF": "Financials", "XLE": "Energy", "XLV": "Health Care",
    "XLY": "Cons. Discretionary", "XLP": "Cons. Staples", "XLI": "Industrials",
    "XLB": "Materials", "XLU": "Utilities", "XLRE": "Real Estate", "XLC": "Communication Svcs",
}
ALL_SYMBOLS = ["SPY", "QQQ", "IWM"] + SECTORS + ["VIXY", "HYG", "IEF", "SHY", "RSP", "LQD"]

WEIGHTS = {"trend": 0.25, "breadth": 0.25, "vol": 0.20, "credit": 0.20, "curve": 0.10}
MOM_WEIGHTS = {"m3": 0.2, "m6": 0.3, "m12": 0.5}


def load_closes() -> pd.DataFrame:
    series = {}
    for sym in ALL_SYMBOLS:
        path = os.path.join(DATA_DIR, f"{sym}.csv")
        if not os.path.exists(path):
            print(f"WARNING: missing {path}, skipping {sym}", file=sys.stderr)
            continue
        df = pd.read_csv(path, parse_dates=["date"])
        df = df[df["interpolated"].astype(str) != "True"]
        df = df.drop_duplicates(subset="date").set_index("date").sort_index()
        series[sym] = df["close"]
    wide = pd.DataFrame(series)
    wide = wide[wide["SPY"].notna()]
    fillable = [c for c in wide.columns if c not in ("XLRE", "XLC")]
    wide[fillable] = wide[fillable].ffill(limit=2)
    return wide


def roll_z(s: pd.Series, window: int = ROLL) -> pd.Series:
    mu = s.rolling(window).mean()
    sd = s.rolling(window).std(ddof=0)
    return (s - mu) / sd.replace(0, np.nan)


def bucket(score: float) -> str:
    if pd.isna(score):
        return "n/a"
    if score >= 1.25:
        return "strong risk-on"
    if score >= 0.4:
        return "risk-on"
    if score > -0.4:
        return "neutral"
    if score > -1.25:
        return "risk-off / caution"
    return "elevated risk / crash-warning"


def build_regime_frame(px: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=px.index)
    breadth_roc = (px["RSP"] / px["SPY"]).pct_change(20)
    out["z_breadth"] = roll_z(breadth_roc)
    vol_spike = px["VIXY"].rolling(10).mean() / px["VIXY"].rolling(60).mean() - 1.0
    out["z_vol"] = -roll_z(vol_spike)
    credit_roc = (px["HYG"] / px["IEF"]).pct_change(20)
    out["z_credit"] = roll_z(credit_roc)
    curve_roc = (px["IEF"] / px["SHY"]).pct_change(20)
    out["z_curve"] = roll_z(curve_roc)
    for idx in ["SPY", "QQQ", "IWM"]:
        p = px[idx]
        trend_raw = 0.5 * (p / p.rolling(50).mean() - 1.0) + 0.5 * (p / p.rolling(200).mean() - 1.0)
        z_trend = roll_z(trend_raw)
        composite = (
            WEIGHTS["trend"] * z_trend + WEIGHTS["breadth"] * out["z_breadth"]
            + WEIGHTS["vol"] * out["z_vol"] + WEIGHTS["credit"] * out["z_credit"]
            + WEIGHTS["curve"] * out["z_curve"]
        )
        out[f"{idx}_composite"] = roll_z(composite)
    return out


def compute_momentum_scores(px: pd.DataFrame) -> pd.Series:
    scores = {}
    for sec in SECTORS:
        s = px[sec]
        if s.iloc[-252:].isna().any():
            continue
        r3 = s.iloc[-1] / s.iloc[-63] - 1.0
        r6 = s.iloc[-1] / s.iloc[-126] - 1.0
        r12 = s.iloc[-1] / s.iloc[-252] - 1.0
        blended = MOM_WEIGHTS["m3"] * r3 + MOM_WEIGHTS["m6"] * r6 + MOM_WEIGHTS["m12"] * r12
        vol = s.pct_change().iloc[-126:].std() * np.sqrt(252)
        if vol and not np.isnan(vol):
            scores[sec] = blended / vol
    return pd.Series(scores).sort_values(ascending=False)


def supabase_upsert(base_url: str, key: str, table: str, rows, on_conflict: str):
    if not rows:
        return
    r = requests.post(
        f"{base_url}/rest/v1/{table}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        params={"on_conflict": on_conflict},
        data=json.dumps(rows),
        timeout=30,
    )
    if not r.ok:
        raise RuntimeError(f"Supabase upsert into {table} failed: {r.status_code} {r.text}")


def main():
    base_url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    px = load_closes()
    reg = build_regime_frame(px)
    as_of = px.index[-1].strftime("%Y-%m-%d")

    snapshot_rows = []
    history_rows = []
    for idx in ["SPY", "QQQ", "IWM"]:
        score = float(reg[f"{idx}_composite"].iloc[-1])
        snapshot_rows.append({
            "index_symbol": idx, "score": round(score, 4), "bucket": bucket(score),
            "as_of": as_of, "updated_at": pd.Timestamp.now("UTC").isoformat(),
        })
    # append last 8 weeks of daily composite as history rows (upsert is idempotent)
    tail = reg.tail(40)
    for d, row in tail.iterrows():
        history_rows.append({
            "d": d.strftime("%Y-%m-%d"),
            "spy": None if pd.isna(row["SPY_composite"]) else round(float(row["SPY_composite"]), 4),
            "qqq": None if pd.isna(row["QQQ_composite"]) else round(float(row["QQQ_composite"]), 4),
            "iwm": None if pd.isna(row["IWM_composite"]) else round(float(row["IWM_composite"]), 4),
        })
    history_rows = [r for r in history_rows if r["spy"] is not None]

    scores = compute_momentum_scores(px)
    sector_rows = []
    for rank, (tk, sc) in enumerate(scores.items(), start=1):
        s = px[tk]
        sector_rows.append({
            "ticker": tk, "rank": rank, "name": SECTOR_NAMES[tk], "score": round(float(sc), 4),
            "r3": round(float(s.iloc[-1] / s.iloc[-63] - 1) * 100, 2),
            "r6": round(float(s.iloc[-1] / s.iloc[-126] - 1) * 100, 2),
            "r12": round(float(s.iloc[-1] / s.iloc[-252] - 1) * 100, 2),
            "as_of": as_of,
        })

    supabase_upsert(base_url, key, "regime_snapshot", snapshot_rows, "index_symbol")
    supabase_upsert(base_url, key, "regime_history", history_rows, "d")
    supabase_upsert(base_url, key, "sector_rankings", sector_rows, "ticker")
    supabase_upsert(base_url, key, "refresh_log", [{"note": f"as_of={as_of}, symbols={len(px.columns)}"}], "id")

    print(f"Refreshed as of {as_of}: {len(snapshot_rows)} snapshot rows, "
          f"{len(history_rows)} history rows, {len(sector_rows)} sector rows.")


if __name__ == "__main__":
    main()
