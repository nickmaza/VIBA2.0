import type { Metadata } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import RegimeRiver from "@/components/landing/RegimeRiver";
import VibaLogo from "@/components/brand/VibaLogo";
import LegacyHashRedirect from "@/components/landing/LegacyHashRedirect";
import styles from "@/components/landing/landing.module.css";
import { getLandingData } from "@/lib/landing";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz", "wdth"],
  variable: "--font-display",
  display: "swap",
});

export const revalidate = 300;

export const metadata: Metadata = {
  title: "VIBA: read the market before you trade it",
  description:
    "VIBA turns prices, options, insider filings and customer reviews into one reading of the market, then shows the stocks that fit it with an entry, a stop and two targets.",
};

const BUCKET_WORDS: Record<string, string> = {
  "strong risk-on": "strong risk-on",
  "risk-on": "risk-on",
  neutral: "neutral",
  "risk-off / caution": "caution",
  "elevated risk / crash-warning": "crash warning",
};

function Tickers({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <span className={styles.tickers}>
      {list.map((s) => (
        <a key={s} href={`/app#chart/${s}`}>
          {s}
        </a>
      ))}
    </span>
  );
}

/** One stop along the river: the line bends in from the previous stop and out to the next. */
function Stop({
  n,
  side,
  title,
  tab,
  tabLabel,
  children,
  today,
}: {
  n: number;
  side: "left" | "right";
  title: string;
  tab: string;
  tabLabel: string;
  children: React.ReactNode;
  today?: React.ReactNode;
}) {
  return (
    <li className={styles.stop}>
      <svg className={styles.stopRiver} viewBox="0 0 64 100" preserveAspectRatio="none" aria-hidden>
        <path
          d={side === "left" ? "M32 0 C32 22, 56 30, 56 52 S32 82, 32 100" : "M32 0 C32 22, 8 30, 8 52 S32 82, 32 100"}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className={styles.stopMarker} aria-hidden>
        {n}
      </span>
      <div className={styles.stopBody}>
        <h3>{title}</h3>
        {children}
        {today && <p className={styles.stopToday}>{today}</p>}
        <a className={styles.stopLink} href={`/app#${tab}`}>
          Open {tabLabel}
        </a>
      </div>
    </li>
  );
}

export default async function Landing() {
  const d = await getLandingData();
  const mood = d.spy ? BUCKET_WORDS[d.spy.bucket] ?? d.spy.bucket : null;
  const score = d.spy ? (d.spy.score >= 0 ? "+" : "") + d.spy.score.toFixed(2) : null;

  return (
    <div className={`${display.variable} ${styles.page}`}>
      <LegacyHashRedirect />

      <header className={styles.nav}>
        <a href="/" className={styles.wordmark} aria-label="VIBA home">
          <VibaLogo className={styles.logo} />
        </a>
        <nav aria-label="Landing page">
          <a href="#how">How it works</a>
          <a href="#data">The data</a>
          <a href="/app?tour=1">Tour</a>
          <a href="/app" className={styles.navCta}>
            Open VIBA
          </a>
        </nav>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={styles.heroText}>
            <h1>Read the market&rsquo;s mood before you place a trade.</h1>
            <p className={styles.lede}>
              VIBA blends trend, breadth, volatility, credit and interest rates into one regime score, then finds the stocks that fit
              it and writes each one a trade plan: an entry, a stop and two targets.
            </p>
            <div className={styles.ctas}>
              <a href="/app" className={styles.primary}>
                Open VIBA
              </a>
              <a href="/app?tour=1" className={styles.secondary}>
                Take the two-minute tour
              </a>
            </div>
          </div>
          <RegimeRiver points={d.regime} today={d.spy && mood ? { score: d.spy.score, label: mood } : null} />
          <p id="river-caption" className={styles.riverCaption}>
            This is the S&amp;P 500 regime score over the last two years.
            {score && mood ? ` Today it reads ${score}, which VIBA calls ${mood}.` : ""} Above zero, conditions have favored owning
            stocks; below it, they have favored caution.
          </p>
        </section>

        <section id="how" className={styles.how} aria-labelledby="how-title">
          <h2 id="how-title">From the market&rsquo;s mood to one trade, in five steps</h2>
          <p className={styles.sectionLede}>Each step is a tab in VIBA, in the order most people use them.</p>
          <ol className={styles.stops}>
            <Stop
              n={1}
              side="left"
              title="Start with the regime"
              tab="overview"
              tabLabel="Overview"
              today={
                score && mood ? (
                  <>
                    Today SPY reads <b>{score}</b> ({mood})
                    {d.sectors.length ? (
                      <>
                        , and the strongest sectors are <b>{d.sectors.map((s) => s.name).join(", ")}</b>.
                      </>
                    ) : (
                      "."
                    )}
                  </>
                ) : null
              }
            >
              <p>
                The Overview shows SPY, QQQ and IWM with live prices and their regime scores, the five ingredients behind each score,
                and which of the 11 sectors are leading. It tells you whether the tide is with you before you look at a single stock.
              </p>
            </Stop>
            <Stop
              n={2}
              side="right"
              title="Get plays that fit it"
              tab="plays"
              tabLabel="Plays"
              today={
                d.plays.length ? (
                  <>
                    Today&rsquo;s plays: <Tickers list={d.plays.map((p) => p.symbol)} />
                  </>
                ) : null
              }
            >
              <p>
                Inside the three strongest sectors, VIBA picks stocks trading above their 50- and 200-day averages with real volume,
                ranks them by momentum per unit of risk, and writes the case and the plan for each from the stock&rsquo;s own chart.
              </p>
            </Stop>
            <Stop
              n={3}
              side="left"
              title="See where big money leans"
              tab="smart"
              tabLabel="Smart Money"
              today={
                d.smartMoney.length ? (
                  <>
                    Smart money plays right now: <Tickers list={d.smartMoney.map((p) => p.symbol)} />
                  </>
                ) : null
              }
            >
              <p>
                Money flow by sector, options positioning, insider buying from SEC filings, what 12 large hedge funds changed last
                quarter, and the trades members of Congress disclosed. It&rsquo;s supporting evidence, not a signal on its own.
              </p>
            </Stop>
            <Stop
              n={4}
              side="right"
              title="Hear customers before earnings"
              tab="predictive"
              tabLabel="Predictive Plays"
              today={
                d.predictive ? (
                  <>
                    Tracking <b>{d.predictive.tracked}</b> companies: <b>{d.predictive.tailwinds}</b> with a tailwind and{" "}
                    <b>{d.predictive.headwinds}</b> with a headwind into their next report.
                  </>
                ) : null
              }
            >
              <p>
                Research has found that the tone of product reviews predicts a company&rsquo;s next quarter. VIBA scores App Store and Steam
                reviews as they are posted and flags companies whose customers sound unusually upbeat or unhappy, then keeps score
                of how those calls turned out.
              </p>
            </Stop>
            <Stop
              n={5}
              side="left"
              title="Check the chart and the headlines"
              tab="chart"
              tabLabel="Chart & News"
              today={
                d.newsToday !== null ? (
                  <>
                    <b>{d.newsToday}</b> stories in the last 24 hours
                    {d.quotesLive ? (
                      <>
                        , and <b>{d.quotesLive}</b> symbols quoted live.
                      </>
                    ) : (
                      "."
                    )}
                  </>
                ) : null
              }
            >
              <p>
                Search any US stock or ETF and chart it from 1-minute bars with pre- and after-market to daily, add any of 24
                indicators, see the support, resistance and trade plan drawn on the chart, and read its news as it breaks. Prices
                update about every 30 seconds from 4am to 8pm Eastern.
              </p>
            </Stop>
          </ol>
        </section>

        <section id="data" className={styles.data} aria-labelledby="data-title">
          <h2 id="data-title">Where the numbers come from</h2>
          <p className={styles.sectionLede}>
            Everything on screen is computed from public data inside VIBA&rsquo;s own database. Nothing is made up or simulated; if a
            source is down, the panel says so.
          </p>
          <dl className={styles.sources}>
            <div>
              <dt>Prices</dt>
              <dd>Yahoo Finance. Live about every 30 seconds from 4am to 8pm Eastern, plus years of daily history.</dd>
            </div>
            <div>
              <dt>Options</dt>
              <dd>CBOE delayed option chains: call and put volume, premium and implied volatility, hourly in the session.</dd>
            </div>
            <div>
              <dt>Insiders and funds</dt>
              <dd>SEC EDGAR Form 4 filings every few minutes, and 13F holdings for 12 large funds each quarter.</dd>
            </div>
            <div>
              <dt>Congress</dt>
              <dd>Senate and House periodic transaction reports, checked twice an hour.</dd>
            </div>
            <div>
              <dt>Customer reviews</dt>
              <dd>Apple App Store and Steam reviews for 118 apps and games tied to 78 companies.</dd>
            </div>
            <div>
              <dt>News</dt>
              <dd>Yahoo Finance stories for the market and every symbol on screen, every 2 minutes in market hours.</dd>
            </div>
          </dl>
          <p className={styles.disclaimer}>
            VIBA is an evidence-based framework, not financial advice. Scores describe conditions; trade plans are arithmetic on past
            prices, and a stop is a level, not a guaranteed fill.
          </p>
        </section>

        <section id="tour" className={styles.tour} aria-labelledby="tour-title">
          <div className={styles.tourInner}>
            <h2 id="tour-title">New here? Let VIBA show you around.</h2>
            <p>
              The tour opens VIBA and walks through it one panel at a time: what each number means, where to click, and what
              to look at first. It takes about two minutes. You can leave at any step and restart it from the Tour button in the
              menu bar.
            </p>
            <ol className={styles.tourSteps}>
              <li>Reading the regime score and the sector ladder</li>
              <li>Using a play&rsquo;s entry, stop and targets</li>
              <li>Smart money and predictive signals</li>
              <li>Charting any ticker, adding indicators and reading its news</li>
            </ol>
            <div className={styles.ctas}>
              <a href="/app?tour=1" className={styles.primaryDark}>
                Start the tour
              </a>
              <a href="/app" className={styles.secondaryDark}>
                Skip to VIBA
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <VibaLogo className={styles.footerLogo} ink="#e6e6e6" idSuffix="-footer" />
        <span>Market data from Yahoo Finance, CBOE, SEC EDGAR, Senate and House disclosures, Apple App Store and Steam.</span>
      </footer>
    </div>
  );
}
