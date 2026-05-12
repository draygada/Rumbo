import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  insertDeepReflection,
  insertShallowReflection,
  WORK_BLOCKS_QUERY_KEY,
  type WorkBlock,
} from '@/lib/queries'
import type { Task } from '@/types'

interface ReflectionModalProps {
  block: WorkBlock
  /** All tasks the user has — used to resolve task_id → title for shallow batches */
  tasks: Task[]
  userId: string
  onClose: () => void
  onSkip: () => void
}

// ── Tap-target rating row (1–5) ───────────────────────────────────────────────

function RatingRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-black/70">{label}</p>
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={cn(
              'flex h-11 flex-1 items-center justify-center rounded-xl text-sm font-semibold transition-colors',
              value === n
                ? 'bg-[#6B7FBE] text-white'
                : 'bg-[#F5F5F3] text-black/50 hover:bg-[#EEEEF8] hover:text-[#6B7FBE]',
            )}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Completion slider ─────────────────────────────────────────────────────────

function CompletionSlider({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-black/70">% completed</p>
        <span className="text-sm font-bold text-[#6B7FBE]">{Math.round(value * 100)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="w-full accent-[#6B7FBE]"
        style={{ height: 6 }}
      />
      <div className="mt-1 flex justify-between text-xs text-black/30">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
    </div>
  )
}

// ── Deep reflection form ──────────────────────────────────────────────────────

function DeepReflectionForm({
  block,
  userId,
  onDone,
}: {
  block: WorkBlock
  userId: string
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [productivity, setProductivity] = useState(3)
  const [energy, setEnergy] = useState(3)
  const [distraction, setDistraction] = useState(3)
  const [completionRate, setCompletionRate] = useState(1.0)
  const [notes, setNotes] = useState('')

  const mutation = useMutation({
    mutationFn: insertDeepReflection,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WORK_BLOCKS_QUERY_KEY })
      onDone()
    },
  })

  const onSubmit = () => {
    mutation.mutate({
      user_id: userId,
      work_block_id: block.id,
      productivity,
      energy,
      distraction,
      completion_rate: completionRate,
      notes: notes.trim() || null,
    })
  }

  return (
    <div className="space-y-5">
      <RatingRow label="Productivity" value={productivity} onChange={setProductivity} />
      <RatingRow label="Energy" value={energy} onChange={setEnergy} />
      <RatingRow label="Distraction" value={distraction} onChange={setDistraction} />
      <CompletionSlider value={completionRate} onChange={setCompletionRate} />

      <div>
        <label className="block text-sm font-semibold text-black/70 mb-1">
          Notes <span className="font-normal text-black/30">(optional)</span>
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, 300))}
          placeholder="Anything that helped or got in the way?"
          rows={2}
          className="box-border w-full resize-none rounded-xl border-0 bg-[#F5F5F3] px-3 py-2.5 text-sm outline-none ring-1 ring-inset ring-neutral-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6B7FBE]/35"
        />
      </div>

      {mutation.error && (
        <p className="text-sm text-red-600">{(mutation.error as Error).message}</p>
      )}

      <button
        type="button"
        onClick={onSubmit}
        disabled={mutation.isPending}
        className="w-full rounded-xl bg-[#6B7FBE] py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {mutation.isPending ? 'Saving…' : 'Save reflection'}
      </button>
    </div>
  )
}

// ── Shallow reflection form ───────────────────────────────────────────────────

function ShallowReflectionForm({
  block,
  tasks,
  userId,
  onDone,
}: {
  block: WorkBlock
  tasks: Task[]
  userId: string
  onDone: () => void
}) {
  const queryClient = useQueryClient()

  // Find the task for this block; in a batch, other batch blocks share the shallow_batch_id
  const taskForBlock = tasks.find((t) => t.id === block.task_id)
  const initialCompletions: Record<string, boolean> = taskForBlock
    ? { [taskForBlock.id]: false }
    : {}

  const [completions, setCompletions] = useState<Record<string, boolean>>(initialCompletions)

  const mutation = useMutation({
    mutationFn: insertShallowReflection,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WORK_BLOCKS_QUERY_KEY })
      onDone()
    },
  })

  const onSubmit = () => {
    mutation.mutate({
      user_id: userId,
      work_block_id: block.id,
      task_completions: completions,
    })
  }

  const taskList = Object.keys(completions)

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        {taskList.length === 0 && (
          <p className="text-sm text-black/40">No tasks associated with this block.</p>
        )}
        {taskList.map((taskId) => {
          const task = tasks.find((t) => t.id === taskId)
          return (
            <label
              key={taskId}
              className="flex cursor-pointer items-center gap-3 rounded-xl bg-[#F5F5F3] px-4 py-3"
            >
              <input
                type="checkbox"
                checked={completions[taskId] ?? false}
                onChange={(e) =>
                  setCompletions((prev) => ({ ...prev, [taskId]: e.target.checked }))
                }
                className="h-4 w-4 rounded accent-[#6B7FBE]"
              />
              <span className="text-sm font-medium text-black/80">
                {task?.title ?? taskId}
              </span>
            </label>
          )
        })}
      </div>

      {mutation.error && (
        <p className="text-sm text-red-600">{(mutation.error as Error).message}</p>
      )}

      <button
        type="button"
        onClick={onSubmit}
        disabled={mutation.isPending}
        className="w-full rounded-xl bg-[#6B7FBE] py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {mutation.isPending ? 'Saving…' : 'Save reflection'}
      </button>
    </div>
  )
}

// ── Modal shell ───────────────────────────────────────────────────────────────

export function ReflectionModal({ block, tasks, userId, onClose, onSkip }: ReflectionModalProps) {
  const isDeep = block.work_type === 'deep'
  const task = tasks.find((t) => t.id === block.task_id)

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(26,26,46,0.45)', backdropFilter: 'blur(2px)' }}
    >
      <div
        className="relative w-full max-w-md rounded-2xl bg-white px-6 py-6 shadow-xl"
        style={{ border: '1px solid #E8E8EC' }}
      >
        {/* Header */}
        <div className="mb-1 flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-black/30">
              {isDeep ? 'Deep work' : 'Shallow work'} · {formatTime(block.start_time)} – {formatTime(block.end_time)}
            </p>
            <h2 className="mt-1 text-lg font-bold text-[#1A1A2E]">
              {task?.title ?? 'How did that go?'}
            </h2>
          </div>
          <button
            onClick={onSkip}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-black/30 hover:bg-black/5 hover:text-black/60 transition-colors"
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            aria-label="Skip reflection"
          >
            <X size={16} />
          </button>
        </div>

        <p className="mb-5 text-sm text-black/40">
          {isDeep
            ? 'Rate this session — it helps Rumbo schedule better for you.'
            : 'Which tasks did you finish?'}
        </p>

        {isDeep ? (
          <DeepReflectionForm block={block} userId={userId} onDone={onClose} />
        ) : (
          <ShallowReflectionForm block={block} tasks={tasks} userId={userId} onDone={onClose} />
        )}
      </div>
    </div>
  )
}
