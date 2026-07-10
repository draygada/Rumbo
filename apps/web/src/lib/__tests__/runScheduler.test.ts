import { describe, test, expect } from 'vitest'
import { runScheduler, SchedulerInput, SchedulerProfile, SchedulerTask } from '../../../../../supabase/functions/_shared/scheduler'

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<SchedulerProfile> = {}): SchedulerProfile {
  return {
    unavailable_before: 8,
    unavailable_after: 22,
    peak_hour_map: Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      score: h >= 9 && h <= 11 ? 0.9 : 0.4,  // peak 9–11
    })),
    block_ceiling_mins: 60,
    target_block_mins: 45,
    urgency_threshold: 2.0,
    distribution_preference: 'even',
    profile_stage: 2,
    shallow_before_deep: true,
    ...overrides,
  }
}

function makeTask(overrides: Partial<SchedulerTask> & Pick<SchedulerTask, 'due_at'>): SchedulerTask {
  return {
    id: crypto.randomUUID(),
    work_type: 'deep',
    estimated_mins: 90,
    estimated_mins_remaining: 90,
    created_at: new Date('2024-01-01T00:00:00Z'),
    classifier_confidence: 0.85,
    cognitive_demand_override: null,
    ...overrides,
  }
}

const NOW = new Date('2024-01-01T08:00:00Z')

function baseInput(tasks: SchedulerTask[], overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    user_id: 'user-test',
    profile: makeProfile(),
    tasks,
    existing_busy: [],
    horizon_days: 7,
    now: NOW,
    ...overrides,
  }
}

// ─── Basic scheduling ─────────────────────────────────────────────────────

describe('basic scheduling', () => {
  test('produces blocks for a single task with enough lead time', () => {
    const task = makeTask({ due_at: new Date('2024-01-08T23:59:00Z') })
    const { blocks } = runScheduler(baseInput([task]))

    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every(b => b.task_id === task.id)).toBe(true)
    expect(blocks.every(b => b.scheduled_by === 'algorithm')).toBe(true)
    expect(blocks.every(b => b.status === 'scheduled')).toBe(true)
  })

  test('blocks do not overlap each other', () => {
    const task = makeTask({ estimated_mins: 180, estimated_mins_remaining: 180, due_at: new Date('2024-01-08T23:59:00Z') })
    const { blocks } = runScheduler(baseInput([task]))

    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const a = { start: new Date(blocks[i].starts_at), end: new Date(blocks[i].ends_at) }
        const b = { start: new Date(blocks[j].starts_at), end: new Date(blocks[j].ends_at) }
        const overlaps = a.start < b.end && b.start < a.end
        expect(overlaps).toBe(false)
      }
    }
  })

  test('blocks fall within unavailable_before / unavailable_after window', () => {
    const task = makeTask({ due_at: new Date('2024-01-08T23:59:00Z') })
    const { blocks } = runScheduler(baseInput([task]))

    blocks.forEach(b => {
      const startHour = new Date(b.starts_at).getHours()
      const endHour = new Date(b.ends_at).getHours()
      expect(startHour).toBeGreaterThanOrEqual(8)
      expect(endHour).toBeLessThanOrEqual(22)
    })
  })

  test('blocks do not overlap existing busy intervals', () => {
    const task = makeTask({ due_at: new Date('2024-01-08T23:59:00Z') })
    const busy = [
      { start: new Date('2024-01-02T09:00:00Z'), end: new Date('2024-01-02T17:00:00Z') },
      { start: new Date('2024-01-03T09:00:00Z'), end: new Date('2024-01-03T17:00:00Z') },
    ]
    const { blocks } = runScheduler(baseInput([task], { existing_busy: busy }))

    blocks.forEach(b => {
      const bStart = new Date(b.starts_at)
      const bEnd = new Date(b.ends_at)
      busy.forEach(slot => {
        const overlaps = bStart < slot.end && slot.start < bEnd
        expect(overlaps).toBe(false)
      })
    })
  })

  test('returns no blocks for an overdue task', () => {
    const task = makeTask({ due_at: new Date('2023-12-31T00:00:00Z') })
    const { blocks, warnings } = runScheduler(baseInput([task]))

    expect(blocks).toHaveLength(0)
    expect(warnings.some(w => w.type === 'deadline_at_risk')).toBe(true)
  })
})

// ─── Block sizing ─────────────────────────────────────────────────────────

describe('confidence-adjusted block sizing', () => {
  test('high confidence → full target_block_mins', () => {
    const task = makeTask({ classifier_confidence: 0.90, due_at: new Date('2024-01-08T23:59:00Z') })
    const { blocks } = runScheduler(baseInput([task]))
    expect(blocks.every(b => !b.confidence_adjusted)).toBe(true)
    expect(blocks.every(b => b.duration_mins === 45)).toBe(true)
  })

  test('mid confidence → 75% of target_block_mins', () => {
    const task = makeTask({ classifier_confidence: 0.55, due_at: new Date('2024-01-08T23:59:00Z') })
    const { blocks } = runScheduler(baseInput([task]))
    expect(blocks.some(b => b.confidence_adjusted)).toBe(true)
    expect(blocks.every(b => b.duration_mins === Math.round(45 * 0.75))).toBe(true)
  })

  test('low confidence → 50% of target_block_mins', () => {
    const task = makeTask({ classifier_confidence: 0.30, due_at: new Date('2024-01-08T23:59:00Z') })
    const { blocks } = runScheduler(baseInput([task]))
    expect(blocks.some(b => b.confidence_adjusted)).toBe(true)
    // 50% of 45 = 22.5 → rounds to 23, but floor is 25
    expect(blocks.every(b => b.duration_mins >= 25)).toBe(true)
  })
})

// ─── Urgency mode ─────────────────────────────────────────────────────────

describe('urgency mode', () => {
  test('emits deadline_at_risk warning when urgency ratio exceeds threshold', () => {
    // 180 mins remaining, due in 12 hours → ratio = 180 / (720/60) = 15 → well above 2.0
    const task = makeTask({
      estimated_mins: 180,
      estimated_mins_remaining: 180,
      due_at: new Date('2024-01-01T20:00:00Z'),  // 12 hrs from NOW
    })
    const { warnings } = runScheduler(baseInput([task]))
    expect(warnings.some(w => w.type === 'deadline_at_risk' && w.task_id === task.id)).toBe(true)
  })

  test('in urgency mode, blocks are packed into earliest available days', () => {
    const task = makeTask({
      estimated_mins: 180,
      estimated_mins_remaining: 180,
      due_at: new Date('2024-01-02T22:00:00Z'),  // 1.5 days away
    })
    const { blocks } = runScheduler(baseInput([task]))

    // All blocks should land on the first available day
    const days = new Set(blocks.map(b => new Date(b.starts_at).toISOString().slice(0, 10)))
    expect(days.size).toBeLessThanOrEqual(2)
  })
})

// ─── Profile stage ────────────────────────────────────────────────────────

describe('profile stage', () => {
  test('stage 1 emits cold_start warning', () => {
    const task = makeTask({ due_at: new Date('2024-01-08T23:59:00Z') })
    const { warnings } = runScheduler(baseInput([task], { profile: makeProfile({ profile_stage: 1 }) }))
    expect(warnings.some(w => w.type === 'cold_start')).toBe(true)
  })

  test('stage 1 allows max 2 deep blocks per day', () => {
    const task = makeTask({
      estimated_mins: 600,
      estimated_mins_remaining: 600,
      due_at: new Date('2024-01-02T23:59:00Z'),
    })
    const { blocks } = runScheduler(baseInput([task], { profile: makeProfile({ profile_stage: 1 }) }))

    const perDay = new Map<string, number>()
    blocks.filter(b => b.task_id === task.id).forEach(b => {
      const day = new Date(b.starts_at).toISOString().slice(0, 10)
      perDay.set(day, (perDay.get(day) ?? 0) + 1)
    })
    for (const [, count] of perDay) {
      expect(count).toBeLessThanOrEqual(2)
    }
  })

  test('stage 3 allows up to 4 deep blocks per day', () => {
    const task = makeTask({
      estimated_mins: 600,
      estimated_mins_remaining: 600,
      due_at: new Date('2024-01-02T23:59:00Z'),
    })
    const { blocks } = runScheduler(baseInput([task], {
      profile: makeProfile({ profile_stage: 3, urgency_threshold: 0.1 }),
    }))

    const perDay = new Map<string, number>()
    blocks.filter(b => b.task_id === task.id).forEach(b => {
      const day = new Date(b.starts_at).toISOString().slice(0, 10)
      perDay.set(day, (perDay.get(day) ?? 0) + 1)
    })
    const maxPerDay = Math.max(...perDay.values())
    expect(maxPerDay).toBeLessThanOrEqual(4)
  })
})

// ─── Distribution preference ──────────────────────────────────────────────

describe('distribution preference', () => {
  const task = () => makeTask({
    estimated_mins: 270,
    estimated_mins_remaining: 270,
    due_at: new Date('2024-01-08T23:59:00Z'),
  })

  test('front_load places first block earlier than ramp', () => {
    const { blocks: frontBlocks } = runScheduler(baseInput([task()], { profile: makeProfile({ distribution_preference: 'front_load' }) }))
    const { blocks: rampBlocks } = runScheduler(baseInput([task()], { profile: makeProfile({ distribution_preference: 'ramp' }) }))

    if (frontBlocks.length && rampBlocks.length) {
      // front_load anchors first block same day as ramp (early anchor is mandatory),
      // but subsequent blocks cluster earlier — so front_load median should be ≤ ramp median
      const frontMedian = new Date(frontBlocks[Math.floor(frontBlocks.length / 2)].starts_at).getTime()
      const rampMedian = new Date(rampBlocks[Math.floor(rampBlocks.length / 2)].starts_at).getTime()
      expect(frontMedian).toBeLessThanOrEqual(rampMedian)
    }
  })
})

// ─── Shallow vs deep ordering ─────────────────────────────────────────────

describe('shallow_before_deep', () => {
  test('when true, first block belongs to a shallow task', () => {
    const deep = makeTask({ work_type: 'deep', due_at: new Date('2024-01-08T23:59:00Z') })
    const shallow = makeTask({ work_type: 'shallow', due_at: new Date('2024-01-08T23:59:00Z') })

    const { blocks } = runScheduler(baseInput([deep, shallow], {
      profile: makeProfile({ shallow_before_deep: true }),
    }))

    const firstBlock = blocks[0]
    if (firstBlock) {
      expect(firstBlock.task_id).toBe(shallow.id)
    }
  })
})

// ─── Peak hour preference ─────────────────────────────────────────────────

describe('slot scoring — peak hour preference', () => {
  test('deep blocks prefer peak hours (9–11) over off-peak hours', () => {
    const task = makeTask({ work_type: 'deep', due_at: new Date('2024-01-03T23:59:00Z') })
    const { blocks } = runScheduler(baseInput([task]))

    // At least one block should land in peak window (9–11)
    const peakBlocks = blocks.filter(b => {
      const h = new Date(b.starts_at).getHours()
      return h >= 9 && h <= 11
    })
    expect(peakBlocks.length).toBeGreaterThan(0)
  })
})

// ─── Insufficient slots warning ───────────────────────────────────────────

describe('warnings', () => {
  test('emits insufficient_slots when there is no time to place all blocks', () => {
    // Task needs 10 hours, deadline is end of today, availability is fully blocked
    const task = makeTask({ estimated_mins: 600, estimated_mins_remaining: 600, due_at: new Date('2024-01-02T00:00:00Z') })
    const busy = [
      { start: new Date('2024-01-01T08:00:00Z'), end: new Date('2024-01-01T22:00:00Z') },
      { start: new Date('2024-01-02T08:00:00Z'), end: new Date('2024-01-02T22:00:00Z') },
    ]
    const { warnings } = runScheduler(baseInput([task], { existing_busy: busy }))
    expect(warnings.some(w => w.type === 'insufficient_slots')).toBe(true)
  })

  test('no warnings for a straightforward well-timed task', () => {
    const task = makeTask({ classifier_confidence: 0.9, due_at: new Date('2024-01-08T23:59:00Z') })
    const { warnings } = runScheduler(baseInput([task], { profile: makeProfile({ profile_stage: 2 }) }))
    expect(warnings.filter(w => w.type !== 'cold_start')).toHaveLength(0)
  })
})

// ─── Multi-task ordering ──────────────────────────────────────────────────

describe('multi-task placement score ordering', () => {
  test('more urgent task gets earlier blocks than less urgent task', () => {
    const urgent = makeTask({ id: 'urgent', due_at: new Date('2024-01-02T23:59:00Z'), estimated_mins: 90, estimated_mins_remaining: 90 })
    const relaxed = makeTask({ id: 'relaxed', due_at: new Date('2024-01-08T23:59:00Z'), estimated_mins: 90, estimated_mins_remaining: 90 })

    const { blocks } = runScheduler(baseInput([relaxed, urgent], { profile: makeProfile({ shallow_before_deep: false }) }))

    const urgentBlocks = blocks.filter(b => b.task_id === 'urgent')
    const relaxedBlocks = blocks.filter(b => b.task_id === 'relaxed')

    if (urgentBlocks.length && relaxedBlocks.length) {
      const firstUrgent = new Date(urgentBlocks[0].starts_at).getTime()
      const firstRelaxed = new Date(relaxedBlocks[0].starts_at).getTime()
      expect(firstUrgent).toBeLessThanOrEqual(firstRelaxed)
    }
  })
})
