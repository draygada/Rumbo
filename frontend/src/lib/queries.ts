import { supabase } from './supabase'
import type { Task } from '../types'

// ── Tasks ─────────────────────────────────────────────────────────────────────

export const TASKS_QUERY_KEY = ['tasks'] as const

export type InsertTaskPayload = Omit<
  Task,
  'id' | 'created_at' | 'deleted_at' | 'description_hash' | 'pdf_url' | 'pdf_hash' | 'calendar_color'
>

export async function fetchTasks(userId: string): Promise<Task[]> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('due_date', { ascending: true })

  if (error) throw new Error(error.message)
  return (data ?? []) as Task[]
}

export async function insertTask(payload: InsertTaskPayload): Promise<Task> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase
    .from('tasks')
    .insert(payload)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as Task
}

// ── Work Blocks ───────────────────────────────────────────────────────────────

export const WORK_BLOCKS_QUERY_KEY = ['work_blocks'] as const

export type WorkBlockStatus = 'upcoming' | 'active' | 'done' | 'missed'

export interface WorkBlock {
  id: string
  user_id: string
  task_id: string
  start_time: string
  end_time: string
  duration_mins: number
  work_type: 'deep' | 'shallow' | null
  status: WorkBlockStatus
  slot_score: number | null
  scheduled_by: 'algorithm' | 'manual' | null
  calendar_event_id: string | null
  shallow_batch_id: string | null
  created_at: string
}

export async function fetchTodayBlocks(userId: string): Promise<WorkBlock[]> {
  if (!supabase) throw new Error('Supabase not configured')
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const endOfDay = new Date()
  endOfDay.setHours(23, 59, 59, 999)

  const { data, error } = await supabase
    .from('work_blocks')
    .select('*')
    .eq('user_id', userId)
    .gte('start_time', startOfDay.toISOString())
    .lte('start_time', endOfDay.toISOString())
    .order('start_time', { ascending: true })

  if (error) throw new Error(error.message)
  return (data ?? []) as WorkBlock[]
}

export async function updateWorkBlockStatus(
  id: string,
  status: WorkBlockStatus,
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase
    .from('work_blocks')
    .update({ status })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Reflections ───────────────────────────────────────────────────────────────

export interface DeepReflectionPayload {
  user_id: string
  work_block_id: string
  productivity: number    // 1–5
  energy: number          // 1–5
  distraction: number     // 1–5
  completion_rate: number // 0.0–1.0
  notes: string | null
}

export interface ShallowReflectionPayload {
  user_id: string
  work_block_id: string
  task_completions: Record<string, boolean>
}

export async function insertDeepReflection(
  payload: DeepReflectionPayload,
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('deep_reflections').insert(payload)
  if (error) throw new Error(error.message)
}

export async function insertShallowReflection(
  payload: ShallowReflectionPayload,
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('shallow_reflections').insert(payload)
  if (error) throw new Error(error.message)
}

// ── Calendar connections ──────────────────────────────────────────────────────

export const CALENDAR_CONNECTIONS_QUERY_KEY = ['calendar_connections'] as const

export async function fetchCalendarConnections(userId: string): Promise<boolean> {
  if (!supabase) return false
  const { data } = await supabase
    .from('calendar_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1)
  return (data?.length ?? 0) > 0
}
