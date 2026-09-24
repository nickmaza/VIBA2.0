// The curated VIBA plays: individual stocks and leveraged sector ETFs drawn
// from the top of the sector ranking. The written case for each play lives
// here; the technical setup (entry / stop / take-profits and the confirmed vs
// pending checklist) is computed live from price bars by lib/ta.ts, so the
// numbers always match the chart.
//
// Rule: no index products as plays (SPY, QQQ, IWM, DIA or their leveraged
// versions). Leveraged picks must be sector funds.

export interface Play {
  symbol: string;
  name: string;
  kind: "stock" | "leveraged";
  sector: string;
  score: number; // risk-adjusted momentum at selection (avg 3/6/12m return / 63d vol)
  vol: number; // 63-day annualized volatility, percent
  thesis: string; // the case for the name
  chartRead: string; // what the chart is doing and what to watch
  risk: string; // the main risk in one line
}

export interface WatchItem {
  symbol: string;
  name: string;
  kind: "stock" | "leveraged";
  note: string;
}

export const EXCLUDED_INDEX_PRODUCTS = ["SPY", "QQQ", "IWM", "DIA", "TQQQ", "UPRO", "SPXL", "SSO", "QLD", "TNA", "UDOW"];

const DATA: { asOf: string; stocks: Play[]; leveraged: Play[]; watchlist: WatchItem[] } = {
  "asOf": "2026-09-23",
  "stocks": [
    {
      "symbol": "MU",
      "name": "Micron Technology",
      "kind": "stock",
      "sector": "Technology · Memory semis",
      "score": 2.87,
      "vol": 84,
      "thesis": "Micron is the strongest momentum name in the whole screen. The stock is up roughly 590% from its September 2025 low of $154.65 and is now a $1.2 trillion company, driven by demand for high-bandwidth memory in AI data centers. Even after that run it trades at about 25× earnings, cheaper than most AI hardware peers, because memory earnings have grown about as fast as the price.",
      "chartRead": "The stock peaked at $1,255 on June 25 and spent the summer correcting about 15%. It has since built a base around $1,000–1,040 and has closed back above the $1,039 shelf that capped it through August. The breakout needs volume to confirm it; the stock moves about 5% on a typical day, so size smaller than usual.",
      "risk": "High volatility (84% annualized). Moves of 5%+ in a day are routine; size small."
    },
    {
      "symbol": "AMD",
      "name": "Advanced Micro Devices",
      "kind": "stock",
      "sector": "Technology · Semis",
      "score": 2.43,
      "vol": 69,
      "thesis": "AMD closed at a record $624.69 intraday high on Sept 23, up about 35% in a month and nearly 300% in a year, and is now a $1 trillion company. It has the cleanest trend on the board: above every moving average, with each pullback this year bought quickly. The catch is valuation at about 160× trailing earnings, so the stock depends on AI accelerator growth continuing.",
      "chartRead": "RSI is above 70 and price is about 16% above its 21-day EMA, which is stretched even for a leader. The engine flags it as extended: the trend is a buy, but not at this price. The plan waits for a pullback toward the 21-day EMA, where the August breakout area near $580 adds support.",
      "risk": "RSI 80+: short-term overbought. Better entered on a pullback toward the 50-day than chased here."
    },
    {
      "symbol": "VLO",
      "name": "Valero Energy",
      "kind": "stock",
      "sector": "Energy · Refining",
      "score": 2.21,
      "vol": 36,
      "thesis": "Energy is the #1 ranked sector, and refiners are leading it. Valero is up about 55% in three months on strong refining margins, yet trades at about 16× earnings with a 1.25% dividend. Its momentum score is among the best on the screen because volatility is only about 36%, low for a stock moving this fast.",
      "chartRead": "Valero set a new high at $419 on Sept 21, then swung sharply on Sept 23 (low $365, high $388), which suggests a shakeout. It closed right on its rising 21-day EMA (about $377). The setup is a pullback entry: wait for price to turn back up before buying, with the stop under the recent swing low.",
      "risk": "Refiners move together; pair it with MPC only at half size each. Sensitive to crack spreads."
    },
    {
      "symbol": "MPC",
      "name": "Marathon Petroleum",
      "kind": "stock",
      "sector": "Energy · Refining",
      "score": 2.15,
      "vol": 35,
      "thesis": "Marathon Petroleum is the second refining play and has the same drivers as Valero, with the lowest volatility of the energy leaders and the cheapest valuation of the picks at about 13× earnings. It is up about 57% in three months and more than doubled in the past year.",
      "chartRead": "MPC topped at $431 on Sept 21 and is about 10% below that high, back at its rising 21-day EMA. Treat VLO and MPC as one position split in two, since they move together. The plan is the same: buy only once price turns up off support.",
      "risk": "Correlated with VLO. A break of the 50-day would signal the refining trade is fading."
    },
    {
      "symbol": "TMO",
      "name": "Thermo Fisher Scientific",
      "kind": "stock",
      "sector": "Health Care · Life-science tools",
      "score": 1.32,
      "vol": 28,
      "thesis": "Thermo Fisher is a quality compounder that has come back to life. It is up about 53% from its May low of $435 and closed at a new 52-week high on Sept 23. It has the smoothest trend of all the picks, with 29% volatility, and gives health-care exposure that doesn't depend on a single drug. It trades at about 35× earnings.",
      "chartRead": "Price is pressing against the $671 high it set on Sept 23. That is a textbook breakout setup, but it only counts on a daily close above the high on above-average volume. RSI in the low 70s means a short pause first would be normal.",
      "risk": "RSI in the high 70s. Expect some consolidation after the run."
    },
    {
      "symbol": "MRK",
      "name": "Merck & Co.",
      "kind": "stock",
      "sector": "Health Care · Pharma",
      "score": 1.29,
      "vol": 35,
      "thesis": "Merck has nearly doubled from its September 2025 low of $77.58, one of the strongest large-pharma runs in years, and pays a 2.2% dividend. The reported P/E of about 120 is distorted by one-time charges, so it isn't a useful valuation read here. The trend is intact above the 50- and 200-day averages.",
      "chartRead": "The stock peaked at $156.92 on Aug 25 and has spent a month consolidating. RSI has cooled to the mid-50s and price is sitting near its 21-day EMA and the $145.75 support shelf. The setup buys the turn higher off that support.",
      "risk": "Near-term momentum is flat. Needs to hold the 50-day to stay a play."
    }
  ],
  "leveraged": [
    {
      "symbol": "ROM",
      "name": "ProShares Ultra Technology",
      "kind": "leveraged",
      "sector": "2× Technology",
      "score": 1.04,
      "vol": 55,
      "thesis": "ROM gives 2× daily exposure to large-cap US tech, the #2 sector in the ranking. It has more than doubled from its March 30 low of $71.36. It is the best risk-adjusted leveraged fund on the screen and has half the volatility of the 3× TECL, so less value is lost to daily resets.",
      "chartRead": "ROM closed back above the $155 level that capped it twice in August and September, and the engine counts that breakout as confirmed. Leveraged funds suit trades held for days or weeks. Take partial profits at TP1 rather than holding for the full move.",
      "risk": "2× daily reset: holding through choppy weeks erodes returns even if tech ends flat."
    },
    {
      "symbol": "CURE",
      "name": "Direxion Daily Healthcare Bull 3×",
      "kind": "leveraged",
      "sector": "3× Health Care",
      "score": 0.84,
      "vol": 55,
      "thesis": "CURE gives 3× daily exposure to S&P 500 health care, the #3 sector, and pairs with the TMO and MRK stock plays. It is up about 67% over 12 months and sits above both long-term averages. Its $121 support has held seven separate tests over the past year, which makes it the clearest risk line of any leveraged pick.",
      "chartRead": "CURE dipped about 10% over the past month and RSI is back to neutral (about 50), so this is a pullback setup. At 3× leverage, a 3% drop in health care costs about 9%. Wait for the turn higher to trigger, and keep size small.",
      "risk": "3× daily leverage. A 10% sector drop costs about 30%."
    },
    {
      "symbol": "ERX",
      "name": "Direxion Daily Energy Bull 2×",
      "kind": "leveraged",
      "sector": "2× Energy",
      "score": 0.98,
      "vol": 42,
      "thesis": "ERX gives 2× daily exposure to large-cap energy, the #1 ranked sector. It is up about 85% over 12 months. Because the energy sector is heavy in integrated oil majors, it is a steadier way to play the sector than the more volatile refiners.",
      "chartRead": "ERX set a high of $115.81 on Sept 10 and has pulled back to its 50-day average (about $101), just above the $98 support shelf that has held three tests, while staying above its 50- and 200-day averages. RSI in the mid-40s shows momentum has reset. The setup waits for a turn higher before entering.",
      "risk": "RSI 35 shows weak short-term momentum. Wait for it to turn up before adding."
    }
  ],
  "watchlist": [
    {
      "symbol": "PSX",
      "kind": "stock",
      "note": "Third refiner. Held back to avoid stacking three names in one industry.",
      "name": "Phillips 66"
    },
    {
      "symbol": "JNJ",
      "kind": "stock",
      "note": "Health-care backup if TMO or MRK breaks trend.",
      "name": "Johnson & Johnson"
    },
    {
      "symbol": "AAPL",
      "kind": "stock",
      "note": "Tech backup with lower volatility than MU or AMD.",
      "name": "Apple"
    },
    {
      "symbol": "TECL",
      "kind": "leveraged",
      "note": "3× version of ROM. Stronger moves both ways; ROM ranks higher risk-adjusted.",
      "name": "Direxion Daily Technology Bull 3×"
    },
    {
      "symbol": "SOXL",
      "kind": "leveraged",
      "note": "3× semis. Still 50% below its high after a 34% 3-month drop; 150%+ volatility.",
      "name": "Direxion Daily Semiconductor Bull 3×"
    },
    {
      "symbol": "LABU",
      "kind": "leveraged",
      "note": "Cut from plays: fell 12% on Sept 23 and closed below its 50-day.",
      "name": "Direxion Daily S&P Biotech Bull 3×"
    }
  ]
};

export const PLAYS_AS_OF = DATA.asOf;
export const STOCK_PLAYS = DATA.stocks;
export const LEVERAGED_PLAYS = DATA.leveraged;
export const WATCHLIST = DATA.watchlist;
export const ALL_PLAYS: Play[] = [...DATA.stocks, ...DATA.leveraged];

export const PLAY_NAMES: Record<string, string> = Object.fromEntries(
  [...ALL_PLAYS.map((p) => [p.symbol, p.name]), ...DATA.watchlist.map((w) => [w.symbol, w.name])]
);
