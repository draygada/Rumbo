"use client"

import * as React from "react"
import { fromDate, getLocalTimeZone, type DateValue } from "@internationalized/date"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar-rac"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export type DueDateTimeValue = {
  date: Date | undefined
  time: string // HH:MM:SS
}

export function CalendarDueDateTime({
  value,
  onChange,
  onCalendarOpenChange,
}: {
  value: DueDateTimeValue
  onChange: (next: DueDateTimeValue) => void
  onCalendarOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = React.useState(false)
  const selectedDateValue = React.useMemo<DateValue | null>(
    () => (value.date ? fromDate(value.date, getLocalTimeZone()) : null),
    [value.date],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <Label htmlFor="date" className="px-1 text-sm !font-bold text-black/70">
          Due date
        </Label>
        <Popover
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen)
            onCalendarOpenChange?.(nextOpen)
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              id="date"
              className="h-11 w-full min-w-0 justify-between rounded-xl border-0 font-normal shadow-none ring-1 ring-inset ring-neutral-300/90 hover:bg-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35 focus-visible:ring-offset-0"
            >
              {value.date ? value.date.toLocaleDateString() : "Select date"}
              <ChevronDownIcon className="h-4 w-4 text-black/50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="w-auto max-h-[min(290px,calc(100vh-24px))] overflow-y-auto overflow-x-hidden p-1"
            align="start"
            side="bottom"
            collisionPadding={12}
          >
            <Calendar
              compact
              value={selectedDateValue}
              onChange={(date) => {
                onChange({
                  ...value,
                  date: date ? date.toDate(getLocalTimeZone()) : undefined,
                })
                setOpen(false)
              }}
            />
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex flex-col gap-3">
        <Label htmlFor="time-due" className="px-1 text-sm !font-bold text-black/70">
          Time
        </Label>
        <Input
          type="time"
          id="time-due"
          step="60"
          value={value.time}
          onChange={(e) => onChange({ ...value, time: e.target.value })}
          className="h-11 min-w-0 rounded-xl border-0 bg-background ring-1 ring-inset ring-neutral-300/90 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rumbo-primary/35 focus-visible:ring-offset-0 appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
        />
      </div>
    </div>
  )
}

