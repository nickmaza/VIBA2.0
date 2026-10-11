-- Predictive Plays: consumer review tone as a leading signal for sales,
-- earnings surprises and announcement returns, after Jin (2023), "More than
-- words: Can tone of consumer product reviews help predict firms'
-- fundamentals?", Journal of Business Finance & Accounting 50(9-10).
--
-- Reviews come from public, programmatic sources:
--   * App Store customer reviews RSS (itunes.apple.com, US storefront) for
--     companies whose app is the product or the main sales channel
--   * Steam's review API for video game publishers
-- sync-reviews scores every review with the Hu & Liu customer-review lexicon
-- and stores daily sums per product and star rating (review text is kept only
-- for the latest few reviews per product); compute-predictive turns them into
-- firm-level tone, controls for rating, volume and dispersion, and writes the
-- Predictive Plays tab.

-- ---------------------------------------------------------------- tables
create table if not exists public.review_products (
  source text not null check (source in ('appstore', 'steam')),
  product_id text not null,
  ticker text not null,
  name text not null,
  publisher text,
  link text not null default 'core' check (link in ('core', 'channel')),
  active boolean not null default true,
  added_at timestamptz not null default now(),
  primary key (source, product_id)
);
comment on column public.review_products.link is
  'core: the reviewed product is the business (Uber, Duolingo, a publisher''s games); channel: the app is a sales channel (retailers, restaurants)';

create table if not exists public.review_watermarks (
  source text not null,
  product_id text not null,
  storefront text not null default 'us',
  last_review_id numeric, -- highest review id already counted
  last_review_at timestamptz,
  last_fetch_at timestamptz,
  last_status text,
  backfilled_to date,     -- Steam: days before this date still to backfill (null = not started)
  primary key (source, product_id, storefront)
);

-- Daily sums per product and star rating (Steam: 5 = recommended, 1 = not
-- recommended). Sums let any window be aggregated exactly.
create table if not exists public.review_tone_daily (
  source text not null,
  product_id text not null,
  day date not null,
  stars smallint not null check (stars between 1 and 5),
  ticker text not null,
  n integer not null default 0,              -- reviews
  words bigint not null default 0,
  pos_words bigint not null default 0,
  neg_words bigint not null default 0,
  pos_tone_sum double precision not null default 0, -- sum of per-review positive words / words
  neg_tone_sum double precision not null default 0, -- sum of per-review negative words / words
  neg_reviews integer not null default 0,    -- reviews with more negative than positive words
  pos_reviews integer not null default 0,    -- reviews with more positive than negative words
  updated_at timestamptz not null default now(),
  primary key (source, product_id, day, stars)
);
create index if not exists review_tone_daily_ticker_day on public.review_tone_daily (ticker, day);

-- Recent reviews per product, shown as examples in the app: a fixed set of
-- slots per product that each sync run overwrites in rotation.
create table if not exists public.review_samples (
  source text not null,
  product_id text not null,
  slot smallint not null check (slot between 0 and 7),
  review_id text not null,
  ticker text not null,
  posted_at timestamptz not null,
  stars smallint not null,
  title text,
  body text,
  words integer not null,
  pos_words integer not null,
  neg_words integer not null,
  updated_at timestamptz not null default now(),
  primary key (source, product_id, slot)
);
create index if not exists review_samples_ticker on public.review_samples (ticker, posted_at desc);

-- Cumulative rating counts from the stores, one snapshot a day: the change
-- between snapshots is review volume.
create table if not exists public.review_volume_daily (
  source text not null,
  product_id text not null,
  day date not null,
  total_count bigint not null,
  avg_rating numeric,
  primary key (source, product_id, day)
);

-- Upcoming earnings dates (Nasdaq earnings calendar).
create table if not exists public.earnings_calendar (
  ticker text not null,
  report_date date not null,
  time_of_day text,        -- pre-market / after-hours / not supplied
  fiscal_quarter text,
  eps_forecast numeric,
  n_estimates integer,
  updated_at timestamptz not null default now(),
  primary key (ticker, report_date)
);
create index if not exists earnings_calendar_date on public.earnings_calendar (report_date);

create table if not exists public.predictive_plays (
  ticker text primary key,
  name text not null,
  industry text,
  sources text not null,
  products text not null,
  link text not null,
  as_of date not null,
  window_days integer not null,
  reviews integer not null,
  baseline_reviews integer not null,
  neg_tone double precision,
  pos_tone double precision,
  neg_tone_abn double precision,  -- negative tone beyond what reviews with the same stars show across the universe
  pos_tone_abn double precision,
  neg_tone_chg double precision,  -- change in abnormal negative tone vs the firm's own baseline window
  pos_tone_chg double precision,
  neg_share double precision,     -- share of reviews with more negative than positive words
  rating double precision,        -- mean rating, 0..1
  dispersion double precision,    -- standard deviation of ratings, 0..1
  volume_per_day double precision,
  score double precision not null,
  signal text not null check (signal in ('tailwind', 'neutral', 'headwind')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  competition text,               -- high / moderate / concentrated
  industry_hhi double precision,
  earnings_date date,
  earnings_time text,
  close numeric,
  ret_1m double precision,
  thesis text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.predictive_signal_history (
  ticker text not null,
  as_of date not null,
  score double precision not null,
  signal text not null,
  confidence text not null,
  reviews integer not null,
  earnings_date date,
  close numeric,
  primary key (ticker, as_of)
);

-- What happened at each report: the signal on the last day before it versus
-- the stock's return around the announcement (day before to day after, minus SPY).
create table if not exists public.predictive_outcomes (
  ticker text not null,
  earnings_date date not null,
  signal_as_of date not null,
  score double precision not null,
  signal text not null,
  confidence text not null,
  pre_close numeric,
  post_close numeric,
  ret double precision,
  spy_ret double precision,
  abn_ret double precision,
  hit boolean,
  computed_at timestamptz not null default now(),
  primary key (ticker, earnings_date)
);

-- ---------------------------------------------------------------- access
alter table public.review_products enable row level security;
alter table public.review_watermarks enable row level security;
alter table public.review_tone_daily enable row level security;
alter table public.review_samples enable row level security;
alter table public.review_volume_daily enable row level security;
alter table public.earnings_calendar enable row level security;
alter table public.predictive_plays enable row level security;
alter table public.predictive_signal_history enable row level security;
alter table public.predictive_outcomes enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['review_products', 'review_tone_daily', 'review_samples', 'review_volume_daily',
                           'earnings_calendar', 'predictive_plays', 'predictive_signal_history', 'predictive_outcomes']
  loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'public read') then
      execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
    end if;
  end loop;
  foreach t in array array['review_products', 'review_watermarks', 'review_tone_daily', 'review_samples', 'review_volume_daily',
                           'earnings_calendar', 'predictive_plays', 'predictive_signal_history', 'predictive_outcomes']
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke select on public.review_watermarks from anon, authenticated;

-- ---------------------------------------------------------------- RPCs
-- Applies one sync run per product atomically: the tone sums, the samples
-- and the watermark move together. A product whose watermark moved since the
-- run read it (another run counted those reviews) is skipped, so a review is
-- never counted twice. Backfill items (Steam history, one day at a time,
-- older than the first live run) are guarded the same way by backfilled_to.
create or replace function public.apply_review_batch(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  it jsonb;
  cur numeric;
  prev numeric;
  cur_bf date;
  backfill boolean;
  applied integer := 0;
  skipped integer := 0;
begin
  for it in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    insert into public.review_watermarks (source, product_id, storefront)
    values (it ->> 'source', it ->> 'product_id', coalesce(it ->> 'storefront', 'us'))
    on conflict do nothing;

    select w.last_review_id, w.backfilled_to into cur, cur_bf
      from public.review_watermarks w
     where w.source = it ->> 'source' and w.product_id = it ->> 'product_id'
       and w.storefront = coalesce(it ->> 'storefront', 'us')
       for update;
    backfill := coalesce(it ->> 'mode', 'live') = 'backfill';
    if backfill then
      if cur_bf is distinct from (it ->> 'prev_backfilled_to')::date then
        skipped := skipped + 1;
        continue;
      end if;
    else
      prev := (it ->> 'prev_review_id')::numeric;
      if cur is not null and (prev is null or cur > prev) then
        skipped := skipped + 1;
        continue;
      end if;
    end if;

    insert into public.review_tone_daily as d
      (source, product_id, day, stars, ticker, n, words, pos_words, neg_words,
       pos_tone_sum, neg_tone_sum, neg_reviews, pos_reviews, updated_at)
    select it ->> 'source', it ->> 'product_id', x.day, x.stars, it ->> 'ticker', x.n, x.words, x.pos_words, x.neg_words,
           x.pos_tone_sum, x.neg_tone_sum, x.neg_reviews, x.pos_reviews, now()
      from jsonb_to_recordset(coalesce(it -> 'tone', '[]'::jsonb)) as x(
             day date, stars smallint, n integer, words bigint, pos_words bigint, neg_words bigint,
             pos_tone_sum double precision, neg_tone_sum double precision, neg_reviews integer, pos_reviews integer)
    on conflict (source, product_id, day, stars) do update set
      n = d.n + excluded.n,
      words = d.words + excluded.words,
      pos_words = d.pos_words + excluded.pos_words,
      neg_words = d.neg_words + excluded.neg_words,
      pos_tone_sum = d.pos_tone_sum + excluded.pos_tone_sum,
      neg_tone_sum = d.neg_tone_sum + excluded.neg_tone_sum,
      neg_reviews = d.neg_reviews + excluded.neg_reviews,
      pos_reviews = d.pos_reviews + excluded.pos_reviews,
      updated_at = now();

    insert into public.review_samples as s
      (source, product_id, slot, review_id, ticker, posted_at, stars, title, body, words, pos_words, neg_words, updated_at)
    select it ->> 'source', it ->> 'product_id', x.slot, x.review_id, it ->> 'ticker', x.posted_at, x.stars,
           left(x.title, 200), left(x.body, 600), x.words, x.pos_words, x.neg_words, now()
      from jsonb_to_recordset(coalesce(it -> 'samples', '[]'::jsonb)) as x(
             slot smallint, review_id text, posted_at timestamptz, stars smallint, title text, body text,
             words integer, pos_words integer, neg_words integer)
    on conflict (source, product_id, slot) do update set
      review_id = excluded.review_id, ticker = excluded.ticker, posted_at = excluded.posted_at, stars = excluded.stars,
      title = excluded.title, body = excluded.body, words = excluded.words, pos_words = excluded.pos_words,
      neg_words = excluded.neg_words, updated_at = now();

    if backfill then
      update public.review_watermarks w
         set backfilled_to = (it ->> 'backfilled_to')::date
       where w.source = it ->> 'source' and w.product_id = it ->> 'product_id'
         and w.storefront = coalesce(it ->> 'storefront', 'us');
    else
      update public.review_watermarks w
         set last_review_id = greatest(w.last_review_id, (it ->> 'last_review_id')::numeric),
             last_review_at = greatest(w.last_review_at, (it ->> 'last_review_at')::timestamptz),
             last_fetch_at = now(),
             last_status = it ->> 'status',
             backfilled_to = coalesce(w.backfilled_to, (it ->> 'backfilled_to')::date)
       where w.source = it ->> 'source' and w.product_id = it ->> 'product_id'
         and w.storefront = coalesce(it ->> 'storefront', 'us');
    end if;
    applied := applied + 1;
  end loop;
  return jsonb_build_object('applied', applied, 'skipped', skipped);
end $$;

-- Window sums per ticker, source and star rating for compute-predictive:
-- 'cur' = the last p_cur days, 'base' = the p_base days before that.
create or replace function public.predictive_tone_inputs(p_asof date, p_cur integer, p_base integer)
returns table (
  ticker text, source text, win text, stars smallint, n bigint, words bigint,
  pos_tone_sum double precision, neg_tone_sum double precision, neg_reviews bigint, pos_reviews bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.ticker, d.source,
         case when d.day > p_asof - p_cur then 'cur' else 'base' end,
         d.stars, sum(d.n), sum(d.words), sum(d.pos_tone_sum), sum(d.neg_tone_sum), sum(d.neg_reviews), sum(d.pos_reviews)
    from public.review_tone_daily d
    join public.review_products p on p.source = d.source and p.product_id = d.product_id and p.active
   where d.day > p_asof - p_cur - p_base and d.day <= p_asof
   group by 1, 2, 3, 4
$$;

revoke all on function public.apply_review_batch(jsonb) from public, anon, authenticated;
revoke all on function public.predictive_tone_inputs(date, integer, integer) from public, anon, authenticated;
grant execute on function public.apply_review_batch(jsonb) to service_role;
grant execute on function public.predictive_tone_inputs(date, integer, integer) to service_role;

-- ---------------------------------------------------------------- universe
-- App Store app ids and Steam app ids were resolved with the iTunes Search
-- API and Steam's appdetails API and checked against the seller / publisher.
insert into public.review_products (source, product_id, ticker, name, publisher, link) values
  ('appstore', '368677368',  'UBER', 'Uber - Rides, Eats, Hotels', 'Uber Technologies, Inc.', 'core'),
  ('appstore', '1058959277', 'UBER', 'Uber Eats: Food & Groceries', 'Uber Technologies, Inc.', 'core'),
  ('appstore', '529379082',  'LYFT', 'Lyft', 'Lyft, Inc.', 'core'),
  ('appstore', '719972451',  'DASH', 'DoorDash: Food, Grocery, More', 'DoorDash, Inc.', 'core'),
  ('appstore', '545599256',  'CART', 'Instacart: Groceries & Food', 'Maplebear Inc', 'core'),
  ('appstore', '401626263',  'ABNB', 'Airbnb', 'Airbnb, Inc.', 'core'),
  ('appstore', '367003839',  'BKNG', 'Booking.com: Hotels & Travel', 'Booking.com B.V.', 'core'),
  ('appstore', '427916203',  'EXPE', 'Expedia: Hotels, Flights, Cars', 'Expedia, Inc.', 'core'),
  ('appstore', '1245772818', 'EXPE', 'Vrbo: Vacation Rentals', 'HomeAway.com, Inc.', 'core'),
  ('appstore', '284876795',  'TRIP', 'Tripadvisor: Plan & Book Trips', 'Tripadvisor', 'core'),
  ('appstore', '363590051',  'NFLX', 'Netflix', 'Netflix, Inc.', 'core'),
  ('appstore', '324684580',  'SPOT', 'Spotify: Music and Podcasts', 'Spotify', 'core'),
  ('appstore', '482066631',  'ROKU', 'Roku Remote (Official)', 'ROKU INC', 'core'),
  ('appstore', '1446075923', 'DIS',  'Disney+', 'Disney Electronic Content, Inc.', 'channel'),
  ('appstore', '376510438',  'DIS',  'Hulu: Stream TV shows & movies', 'Hulu, LLC', 'channel'),
  ('appstore', '905401434',  'FUBO', 'Fubo: Watch Live TV & Sports', 'fuboTV Inc.', 'core'),
  ('appstore', '317951436',  'SIRI', 'SiriusXM: Music, Sports & News', 'Sirius XM Radio, LLC', 'core'),
  ('appstore', '284035177',  'SIRI', 'Pandora: Music & Podcasts', 'Pandora Media, LLC', 'core'),
  ('appstore', '530168168',  'PSKY', 'Paramount+', 'CBS Mobile', 'channel'),
  ('appstore', '429047995',  'PINS', 'Pinterest', 'Pinterest, Inc.', 'core'),
  ('appstore', '447188370',  'SNAP', 'Snapchat', 'Snap, Inc.', 'core'),
  ('appstore', '389801252',  'META', 'Instagram', 'Instagram, Inc.', 'core'),
  ('appstore', '284882215',  'META', 'Facebook', 'Meta Platforms, Inc.', 'core'),
  ('appstore', '310633997',  'META', 'WhatsApp Messenger', 'WhatsApp Inc.', 'core'),
  ('appstore', '1064216828', 'RDDT', 'Reddit', 'REDDIT, INC.', 'core'),
  ('appstore', '547702041',  'MTCH', 'Tinder Dating App: Date & Chat', 'Tinder LLC', 'core'),
  ('appstore', '595287172',  'MTCH', 'Hinge Dating App: Match & Date', 'Hinge, Inc.', 'core'),
  ('appstore', '930441707',  'BMBL', 'Bumble Dating App: Meet & Date', 'Bumble Holding Limited', 'core'),
  ('appstore', '319881193',  'GRND', 'Grindr - Gay Dating & Chat', 'Grindr LLC', 'core'),
  ('appstore', '570060128',  'DUOL', 'Duolingo: Language Lessons', 'Duolingo, Inc', 'core'),
  ('appstore', '431946152',  'RBLX', 'Roblox', 'Roblox Corporation', 'core'),
  ('appstore', '792750948',  'PTON', 'Peloton: Fitness & Workouts', 'Peloton Interactive, Inc.', 'core'),
  ('appstore', '384830320',  'LIF',  'Life360: Family Safety & GPS', 'Life360', 'core'),
  ('appstore', '284862083',  'NYT',  'NYTimes: US and Global News', 'The New York Times Company', 'core'),
  ('appstore', '307569751',  'NYT',  'NYT Games: Wordle & Crossword', 'The New York Times Company', 'core'),
  ('appstore', '938003185',  'HOOD', 'Robinhood: Trading & Investing', 'Robinhood Markets Inc', 'core'),
  ('appstore', '886427730',  'COIN', 'Coinbase: Buy Crypto & Stocks', 'Coinbase, Inc.', 'core'),
  ('appstore', '283646709',  'PYPL', 'PayPal - Pay, Send, Save', 'PayPal, Inc.', 'core'),
  ('appstore', '351727428',  'PYPL', 'Venmo', 'The Delancey Corporation, LLC', 'core'),
  ('appstore', '711923939',  'XYZ',  'Cash App', 'Block, Inc.', 'core'),
  ('appstore', '1191985736', 'SOFI', 'SoFi: Bank, Invest & Crypto', 'Social Finance, LLC', 'core'),
  ('appstore', '967040652',  'AFRM', 'Affirm: Buy now, pay over time', 'Affirm, Inc', 'core'),
  ('appstore', '836215269',  'CHYM', 'Chime – Mobile Banking', 'Chime Financial, Inc.', 'core'),
  ('appstore', '1193801909', 'DAVE', 'Dave: Credit, Cash & Money App', 'Dave, Inc', 'core'),
  ('appstore', '477128284',  'ETSY', 'Etsy: Shop from Real People', 'Etsy, Inc.', 'core'),
  ('appstore', '282614216',  'EBAY', 'eBay online shopping & selling', 'eBay Inc.', 'core'),
  ('appstore', '1149449468', 'CHWY', 'Chewy - Pet Care & Pharmacy', 'Chewy, Inc.', 'core'),
  ('appstore', '836767708',  'W',    'Wayfair – Shop All Things Home', 'Wayfair LLC', 'core'),
  ('appstore', '1273426583', 'CVNA', 'Carvana: Buy/Sell Used Cars', 'Carvana LLC', 'core'),
  ('appstore', '310738695',  'Z',    'Zillow Real Estate & Rentals', 'Zillow, Inc.', 'core'),
  ('appstore', '1455690574', 'HIMS', 'Hims: Telehealth for Men', 'Hims, Inc. (CA)', 'core'),
  ('appstore', '485357017',  'GDRX', 'GoodRx: Prescription Savings', 'GoodRx, Inc.', 'core'),
  ('appstore', '1375031369', 'DKNG', 'DraftKings: Sports & Casino', 'DRAFTKINGS LLC.', 'core'),
  ('appstore', '710535379',  'DKNG', 'DraftKings Fantasy Sports', 'DRAFTKINGS LLC.', 'core'),
  ('appstore', '1413721906', 'FLUT', 'FanDuel Sportsbook & Casino', 'FanDuel Limited', 'core'),
  ('appstore', '447553564',  'PLTK', 'Slotomania Slots Machine Game', 'Playtika LTD', 'core'),
  ('appstore', '284910350',  'YELP', 'Yelp: Food, Services & Reviews', 'Yelp, Inc.', 'core'),
  ('appstore', '1446736499', 'UPWK', 'Upwork', 'Upwork Global Inc.', 'core'),
  ('appstore', '327630330',  'DBX',  'Dropbox: Cloud Storage Backup', 'Dropbox, Inc.', 'core'),
  ('appstore', '546505307',  'ZM',   'Zoom Workplace', 'Zoom Communications, Inc.', 'core'),
  ('appstore', '1223471316', 'SHOP', 'Shop: Track, Pay, Discover', 'Shopify Inc.', 'channel'),
  ('appstore', '297606951',  'AMZN', 'Amazon Shopping', 'AMZN Mobile LLC', 'channel'),
  ('appstore', '338137227',  'WMT',  'Walmart: Shopping & Savings', 'Walmart', 'channel'),
  ('appstore', '382497397',  'WMT',  'Sam''s Club Shopping & Delivery', 'Walmart Stores Inc.', 'channel'),
  ('appstore', '297430070',  'TGT',  'Target: Shop. Style. Save.', 'Target', 'channel'),
  ('appstore', '535509415',  'COST', 'Costco', 'Costco Wholesale Corporation', 'channel'),
  ('appstore', '342527639',  'HD',   'The Home Depot', 'The Home Depot, Inc.', 'channel'),
  ('appstore', '457954781',  'LOW',  'Lowe''s Home Improvement', 'Lowe''s Companies, Inc.', 'channel'),
  ('appstore', '314855255',  'BBY',  'Best Buy: Tech Deals & Savings', 'Best Buy Co., Inc.', 'channel'),
  ('appstore', '403901186',  'KR',   'Kroger', 'The Kroger Co.', 'channel'),
  ('appstore', '1095459556', 'NKE',  'Nike: Engineered for Athletes', 'Nike, Inc', 'channel'),
  ('appstore', '911130812',  'NKE',  'Nike SNKRS: Sneakers & Apparel', 'Nike, Inc', 'channel'),
  ('appstore', '561930308',  'ULTA', 'Ulta Beauty: Makeup & Skincare', 'Ulta Salon, Cosmetics and Fragrance Inc.', 'channel'),
  ('appstore', '920098546',  'LULU', 'lululemon', 'lululemon athletica canada inc.', 'channel'),
  ('appstore', '331177714',  'SBUX', 'Starbucks', 'Starbucks Coffee Company', 'channel'),
  ('appstore', '922103212',  'MCD',  'McDonald''s', 'McDonalds USA LLC', 'channel'),
  ('appstore', '327228455',  'CMG',  'Chipotle', 'Chipotle Mexican Grill', 'channel'),
  ('appstore', '436491861',  'DPZ',  'Domino''s Pizza USA', 'Domino''s Pizza LLC', 'channel'),
  ('appstore', '497387361',  'YUM',  'Taco Bell Fast Food & Delivery', 'Taco Bell', 'channel'),
  ('appstore', '321560858',  'YUM',  'Pizza Hut - Delivery & Takeout', 'Pizza Hut, Inc.', 'channel'),
  ('appstore', '1538999662', 'YUM',  'KFC US: Ordering & Delivery', 'KFC Corporation', 'channel'),
  ('appstore', '638323895',  'QSR',  'BURGER KING App', 'Burger King Corporation', 'channel'),
  ('appstore', '454719277',  'WING', 'Wingstop', 'Wingstop Restaurants, Inc.', 'channel'),
  ('appstore', '407517450',  'PZZA', 'Papa Johns Pizza & Delivery', 'Papa John''s International Inc.', 'channel'),
  ('appstore', '726270499',  'CAVA', 'CAVA | Order Online', 'Cavamezze Grill, LLC', 'channel'),
  ('appstore', '317279545',  'SHAK', 'Shake Shack', 'Shake Shack Inc.', 'channel'),
  ('appstore', '594329490',  'SG',   'sweetgreen', 'Sweetgreen, Inc.', 'channel'),
  ('appstore', '1529179884', 'BROS', 'Dutch Bros', 'Dutch Bros., llc', 'channel'),
  ('steam', '3240220', 'TTWO', 'Grand Theft Auto V Enhanced', 'Rockstar Games', 'core'),
  ('steam', '271590',  'TTWO', 'Grand Theft Auto V Legacy', 'Rockstar Games', 'core'),
  ('steam', '1174180', 'TTWO', 'Red Dead Redemption 2', 'Rockstar Games', 'core'),
  ('steam', '4356430', 'TTWO', 'NBA 2K27', '2K', 'core'),
  ('steam', '3472040', 'TTWO', 'NBA 2K26', '2K', 'core'),
  ('steam', '1285190', 'TTWO', 'Borderlands 4', '2K', 'core'),
  ('steam', '1295660', 'TTWO', 'Sid Meier''s Civilization VII', '2K', 'core'),
  ('steam', '1941540', 'TTWO', 'Mafia: The Old Country', '2K', 'core'),
  ('steam', '3717070', 'TTWO', 'WWE 2K26', '2K', 'core'),
  ('steam', '2385530', 'TTWO', 'PGA TOUR 2K25', '2K', 'core'),
  ('steam', '2767030', 'NTES', 'Marvel Rivals', 'NetEase Games', 'core'),
  ('steam', '1203220', 'NTES', 'NARAKA: BLADEPOINT', 'NetEase Games', 'core'),
  ('steam', '2139460', 'NTES', 'Once Human', 'Starry Studio/NetEase Games', 'core'),
  ('steam', '3564740', 'NTES', 'Where Winds Meet', 'NetEase Games', 'core'),
  ('steam', '553850',  'SONY', 'HELLDIVERS 2', 'PlayStation Publishing LLC', 'channel'),
  ('steam', '2215430', 'SONY', 'Ghost of Tsushima DIRECTOR''S CUT', 'PlayStation Publishing LLC', 'channel'),
  ('steam', '2651280', 'SONY', 'Marvel''s Spider-Man 2', 'PlayStation Publishing LLC', 'channel'),
  ('steam', '2322010', 'SONY', 'God of War Ragnarök', 'PlayStation Publishing LLC', 'channel'),
  ('steam', '3489700', 'SONY', 'Stellar Blade', 'PlayStation Publishing LLC', 'channel'),
  ('steam', '3280350', 'SONY', 'DEATH STRANDING 2: ON THE BEACH', 'PlayStation Publishing LLC', 'channel'),
  ('steam', '1938090', 'MSFT', 'Call of Duty', 'Activision', 'channel'),
  ('steam', '3606480', 'MSFT', 'Call of Duty: Black Ops 7', 'Activision', 'channel'),
  ('steam', '1551360', 'MSFT', 'Forza Horizon 5', 'Xbox Game Studios', 'channel'),
  ('steam', '2483190', 'MSFT', 'Forza Horizon 6', 'Xbox Game Studios', 'channel'),
  ('steam', '2344520', 'MSFT', 'Diablo IV', 'Blizzard Entertainment, Inc.', 'channel'),
  ('steam', '2623190', 'MSFT', 'The Elder Scrolls IV: Oblivion Remastered', 'Bethesda Softworks', 'channel'),
  ('steam', '3017860', 'MSFT', 'DOOM: The Dark Ages', 'Bethesda Softworks', 'channel'),
  ('steam', '1172620', 'MSFT', 'Sea of Thieves', 'Xbox Game Studios', 'channel'),
  ('steam', '1449110', 'MSFT', 'The Outer Worlds 2', 'Xbox Game Studios', 'channel'),
  ('steam', '3010850', 'MSFT', 'Gears of War: E-Day', 'Xbox Game Studios', 'channel')
on conflict (source, product_id) do update set
  ticker = excluded.ticker, name = excluded.name, publisher = excluded.publisher, link = excluded.link;

-- Covered companies that were not yet in the library get daily prices too.
insert into public.symbol_meta (symbol, name, kind, sector_etf, active, industry, market_cap)
select d.symbol, d.name, 'stock', v.etf, true, d.industry, d.market_cap
  from (values ('CAVA', 'XLY'), ('CHYM', 'XLF'), ('FUBO', 'XLC'), ('GDRX', 'XLV'), ('LIF', 'XLK'), ('LULU', 'XLY'),
               ('NTES', 'XLC'), ('PINS', 'XLC'), ('PLTK', 'XLC'), ('PSKY', 'XLC'), ('QSR', 'XLY'), ('SHOP', 'XLK'),
               ('SONY', 'XLY'), ('SPOT', 'XLC'), ('XYZ', 'XLF'), ('YUM', 'XLY')) as v(symbol, etf)
  join public.symbol_directory d on d.symbol = v.symbol
on conflict (symbol) do nothing;

-- Industry concentration (Herfindahl index of market caps per Nasdaq industry)
-- for the competition moderator in compute-predictive.
create or replace function public.industry_concentration()
returns table (industry text, firms integer, hhi double precision)
language sql stable security definer set search_path = '' as $$
  with s as (select d.industry, d.market_cap::double precision as cap from public.symbol_directory d
             where d.type = 'Stock' and d.industry is not null and d.market_cap > 0),
       t as (select s.industry, sum(s.cap) as total, count(*) as firms from s group by s.industry)
  select s.industry, t.firms::integer, sum((s.cap / t.total) ^ 2) from s join t using (industry) group by s.industry, t.firms
$$;
revoke all on function public.industry_concentration() from public, anon, authenticated;
grant execute on function public.industry_concentration() to service_role;

-- Schedules. Every job goes through private.invoke_edge (secret from Vault).
select cron.schedule('reviews-appstore', '*/20 * * * *', $$
  select private.invoke_edge('sync-reviews', '{"source":"appstore","limit":30}'::jsonb, 30000)
$$);
select cron.schedule('reviews-steam', '10 */3 * * *', $$
  select private.invoke_edge('sync-reviews', '{"source":"steam"}'::jsonb, 30000)
$$);
-- Steam history: one day per game per run until each game reaches 84 days back.
select cron.schedule('reviews-steam-backfill', '5-55/10 * * * *', $$
  select private.invoke_edge('sync-reviews', '{"source":"steam","backfill":true}'::jsonb, 30000)
   where exists (select 1 from public.review_watermarks w
                  where w.source = 'steam' and w.backfilled_to > current_date - 84)
$$);
select cron.schedule('reviews-volume', '50 5 * * *', $$
  select private.invoke_edge('sync-reviews', '{"source":"volume"}'::jsonb, 30000)
$$);
select cron.schedule('earnings-calendar', '15 10 * * *', $$
  select private.invoke_edge('sync-earnings', '{}'::jsonb, 30000)
$$);
select cron.schedule('predictive-plays', '30 */2 * * *', $$
  select private.invoke_edge('compute-predictive', '{}'::jsonb, 30000)
$$);
