-- Slow the llamaparse poller from every 30 seconds to every 2 minutes.
--
-- Why: at 30s the poller fired 2,880 times a day — roughly 96% of all
-- scheduled invocations in the project, about 25x every other cron job
-- combined. It early-outs cleanly when there is nothing to drain
-- (`if (jobs.length === 0) return`), so each tick is cheap, but it ran at that
-- rate permanently, including the overwhelming majority of the time when no
-- file was being parsed. Cheap x 86,400/month is not cheap.
--
-- Cost of the change: LlamaParse jobs complete in tens of seconds to minutes,
-- so the added wait is at most ~90s on a parse that already takes that long,
-- and the poller marks jobs stale only after 30 minutes (STALE_MINUTES), which
-- this comes nowhere near. 2,880/day -> 720/day, a 75% reduction.
--
-- If upload-to-searchable latency ever needs to be tighter than this, the
-- right fix is not a faster fixed interval — it is making the poll rate follow
-- the work: the enqueue path knows when a job exists, so it can burst and lapse
-- back to idle. Better still, a LlamaParse webhook would take idle cost to zero.
--
-- The tick function itself is unchanged; only the schedule moves. The old job
-- name is unscheduled explicitly because the name encodes the interval.

do $$
declare
  existing_jobid bigint;
begin
  -- Drop the 30s job by its old name.
  select jobid into existing_jobid from cron.job where jobname = 'llamaparse-poller-30s';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;

  -- And the new name too, so re-running this migration is idempotent.
  select jobid into existing_jobid from cron.job where jobname = 'llamaparse-poller-2m';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;

  perform cron.schedule(
    'llamaparse-poller-2m',
    '*/2 * * * *',
    $job$ select public.llamaparse_poller_cron_tick() $job$
  );
end;
$$;
