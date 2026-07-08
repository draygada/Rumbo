import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { Task, WorkBlock } from '../types'

export interface TaskWithBlocks extends Task {
  work_blocks: WorkBlock[]
}

// Raw DB row shapes (before column mapping)
type RawBlock = Record<string, unknown>
type RawTask = Record<string, unknown> & { work_blocks: RawBlock[] }

function mapBlock(b: RawBlock): WorkBlock {
  return {
    ...(b as Partial<WorkBlock>),
    id: b.id as string,
    user_id: b.user_id as string,
    task_id: b.task_id as string,
    starts_at: b.starts_at as string,
    ends_at: b.ends_at as string,
    duration_mins: (b.duration_mins as number) ?? 0,
    slot_score: (b.slot_score as number) ?? 0,
    placement_score: (b.placement_score as number) ?? 0,
    scheduled_by: ((b.scheduled_by as string) ?? 'algorithm') as WorkBlock['scheduled_by'],
    status: b.status as WorkBlock['status'],
    confidence_adjusted: (b.confidence_adjusted as boolean) ?? false,
    deadline_proximity: (b.deadline_proximity as number) ?? 0,
    calendar_event_id: (b.calendar_event_id as string | null) ?? null,
    created_at: b.created_at as string,
  } as WorkBlock
}

function mapTask(t: RawTask): TaskWithBlocks {
  return {
    ...(t as Partial<Task>),
    id: t.id as string,
    user_id: t.user_id as string,
    title: t.title as string,
    description: (t.description as string | null) ?? null,
    work_type: ((t.work_type as string) ?? 'deep') as Task['work_type'],
    classifier_confidence: (t.classifier_confidence as number) ?? 0.5,
    estimated_mins: t.estimated_mins as number,
    estimated_mins_remaining: (t.estimated_mins_remaining as number) ?? (t.estimated_mins as number),
    // Support both new (due_at) and legacy (due_date) column names
    due_at: (t.due_at ?? t.due_date) as string,
    created_at: t.created_at as string,
    user_overrode_classifier: (t.user_overrode_classifier as boolean) ?? false,
    cognitive_demand_override: (t.cognitive_demand_override as number | null) ?? null,
    work_blocks: (t.work_blocks ?? []).map(mapBlock),
  }
}

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tasks')
        .select('*, work_blocks(*)')
        .order('due_date', { ascending: true })
      if (error) throw error
      return (data as RawTask[]).map(mapTask)
    },
  })
}

/**
 * Subscribes to work_blocks changes for the given user and invalidates
 * the tasks query when blocks are created/updated by the schedule-generator.
 * Call this once on the Dashboard so the UI updates without a manual refresh.
 */
export function useWorkBlocksRealtime(userId: string | undefined) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel(`work_blocks:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'work_blocks', filter: `user_id=eq.${userId}` },
        () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId, queryClient])
}

export interface DeleteTaskInput {
  taskId: string
}

export function useDeleteTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ taskId }: DeleteTaskInput) => {
      const { data, error } = await supabase.functions.invoke('delete-task', {
        body: { task_id: taskId },
      })

      if (error) {
        console.error('[useDeleteTask] delete-task function failed', {
          taskId,
          message: error.message,
          context: (error as { context?: unknown }).context,
        })
        throw error
      }

      if (!data?.ok) {
        throw new Error(data?.error ?? 'Failed to delete task')
      }

      return taskId
    },
    onSuccess: deletedId => {
      queryClient.setQueryData<TaskWithBlocks[]>(['tasks'], current =>
        (current ?? []).filter(task => task.id !== deletedId),
      )
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

/** Next incomplete block for a task, if any. */
export function getNextBlock(task: TaskWithBlocks): WorkBlock | null {
  const now = Date.now()
  const upcoming = (task.work_blocks ?? [])
    .filter(b => b.status !== 'completed' && new Date(b.ends_at).getTime() > now)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  return upcoming[0] ?? null
}
