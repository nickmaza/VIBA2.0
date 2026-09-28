-- library_stats: one row per library symbol with its latest daily statistics
-- (symbol_meta joined to symbol_stats). PostgREST cannot embed symbol_stats
-- from symbol_meta without a foreign key, so the screens and the compute
-- functions read this view instead.
create or replace view public.library_stats
with (security_invoker = true) as
select m.symbol,
       m.name,
       m.kind,
       m.sector_etf,
       m.industry,
       m.market_cap,
       m.active,
       m.cik,
       s.d,
       s.close,
       s.prev_close,
       s.chg,
       s.chg_pct,
       s.r1m,
       s.r3m,
       s.r6m,
       s.r12m,
       s.vol63,
       s.vol126,
       s.dma50,
       s.dma100,
       s.dma200,
       s.hi52,
       s.lo52,
       s.dollar_vol20,
       s.avg_vol20,
       s.bars,
       s.updated_at
  from public.symbol_meta m
  join public.symbol_stats s using (symbol);

revoke all on public.library_stats from anon, authenticated;
grant select on public.library_stats to anon, authenticated;
