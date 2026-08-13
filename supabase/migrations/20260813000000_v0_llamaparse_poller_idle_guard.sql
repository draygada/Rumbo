-- Stop the LlamaParse poller waking up when there is nothing to poll.
--
-- Measured 2026-08-13 over 24h of cron.job_run_details:
--
--   llamaparse-poller-2m    688 runs   66 failed   86% of ALL scheduled runs
--   drive-content-15m        96 runs    9 failed   12%
--   everything else          14 runs    0 failed    2%
--
-- The queue was empty for effectively all of those 688 runs. Slowing the
-- schedule from 30s to 2m (20260812010000) cut the count 4x but did not change
-- the shape of the problem: the tick fires unconditionally, so cost scales with
-- the clock rather than with the work.
--
-- The 66 "job startup timeout" failures are the second-order cost. Those are
-- pg_cron unable to get a worker slot — one job monopolising the scheduler
-- degrades every other job's reliability, which is why drive-content-15m is
-- also dropping runs.
--
-- Fix: ask Postgres whether there is work before paying for an HTTP round-trip
-- into an edge function. An index-backed EXISTS against a small local table is
-- orders of magnitude cheaper than the invocation it replaces, and when the
-- queue is empty the tick now costs approximately nothing.
--
-- Note this makes the SCHEDULE cheap to tighten again. With the guard in place,
-- returning to a faster interval would cost almost nothing while idle and would
-- improve extraction latency when a batch is in flight. Left at 2m here to keep
-- this migration to one change.

-- Supports the EXISTS below without scanning completed history. Partial, since
-- 'pending' is a small and shrinking slice of a table that only accumulates.
create index if not exists llamaparse_jobs_pending_idx
  on public.llamaparse_jobs (requested_at)
  where status = 'pending';

create or replace function public.llamaparse_poller_cron_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare cfg record;
begin
  -- Idle guard. Deliberately FIRST: it is the cheapest check available and it
  -- short-circuits the overwhelming majority of ticks. Reading vault config for
  -- a run that has nothing to do is itself wasted work.
  if not exists (select 1 from public.llamaparse_jobs where status = 'pending') then
    return;
  end if;

  select * into cfg from public._rumbo_cron_config();
  if cfg.fn_url_base is null or cfg.service_key is null or cfg.cron_secret is null then
    raise notice 'llamaparse_poller_cron_tick: vault secrets missing; skipping';
    return;
  end if;

  perform net.http_post(
    url := cfg.fn_url_base || '/functions/v1/llamaparse-poller',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cfg.service_key,
      'x-cron-secret', cfg.cron_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
exception when others then raise warning 'llamaparse_poller_cron_tick failed: %', sqlerrm;
end;
$$;
