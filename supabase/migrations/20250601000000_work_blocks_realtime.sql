-- Enable Realtime for work_blocks so the dashboard updates live
-- when the schedule-generator creates blocks after a task insert.
alter publication supabase_realtime add table public.work_blocks;
