"use client"

import { cn } from "@/lib/utils"
import { getLocalTimeZone, today } from "@internationalized/date"
import { ComponentProps } from "react"
import {
  Button,
  CalendarCell as CalendarCellRac,
  CalendarGridBody as CalendarGridBodyRac,
  CalendarGridHeader as CalendarGridHeaderRac,
  CalendarGrid as CalendarGridRac,
  CalendarHeaderCell as CalendarHeaderCellRac,
  Calendar as CalendarRac,
  Heading as HeadingRac,
  RangeCalendar as RangeCalendarRac,
  composeRenderProps,
} from "react-aria-components"
import { ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons"

interface BaseCalendarProps {
  className?: string
  compact?: boolean
}

type CalendarProps = ComponentProps<typeof CalendarRac> & BaseCalendarProps
type RangeCalendarProps = ComponentProps<typeof RangeCalendarRac> &
  BaseCalendarProps

const CalendarHeader = ({ compact = false }: { compact?: boolean }) => (
  <header className="flex w-full items-center gap-1 pb-1">
    <Button
      slot="previous"
      className={cn(
        "flex items-center justify-center rounded-lg text-muted-foreground/80 outline-offset-2 transition-colors hover:bg-accent hover:text-foreground focus:outline-none data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring/70",
        compact ? "size-8" : "size-9",
      )}
    >
      <ChevronLeftIcon width={16} height={16} />
    </Button>
    <HeadingRac className={cn("grow text-center font-medium", compact ? "text-[13px]" : "text-sm")} />
    <Button
      slot="next"
      className={cn(
        "flex items-center justify-center rounded-lg text-muted-foreground/80 outline-offset-2 transition-colors hover:bg-accent hover:text-foreground focus:outline-none data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring/70",
        compact ? "size-8" : "size-9",
      )}
    >
      <ChevronRightIcon width={16} height={16} />
    </Button>
  </header>
)

const CalendarGridComponent = ({
  isRange = false,
  compact = false,
}: {
  isRange?: boolean
  compact?: boolean
}) => {
  const now = today(getLocalTimeZone())

  return (
    <CalendarGridRac>
      <CalendarGridHeaderRac>
        {(day) => (
          <CalendarHeaderCellRac
            className={cn(
              "rounded-lg p-0 font-medium text-muted-foreground/80",
              compact ? "size-8 text-[11px]" : "size-9 text-xs",
            )}
          >
            {day}
          </CalendarHeaderCellRac>
        )}
      </CalendarGridHeaderRac>
      <CalendarGridBodyRac className="[&_td]:px-0">
        {(date) => (
          <CalendarCellRac
            date={date}
            className={cn(
              "relative flex items-center justify-center whitespace-nowrap rounded-lg border border-transparent p-0 font-normal text-foreground outline-offset-2 duration-150 [transition-property:color,background-color,border-radius,box-shadow] focus:outline-none data-[disabled]:pointer-events-none data-[unavailable]:pointer-events-none data-[focus-visible]:z-10 data-[hovered]:bg-accent data-[selected]:bg-primary data-[hovered]:text-foreground data-[selected]:text-primary-foreground data-[unavailable]:line-through data-[disabled]:opacity-30 data-[unavailable]:opacity-30 data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring/70",
              compact ? "size-8 text-[13px]" : "size-9 text-sm",
              // Range-specific styles
              isRange &&
                "data-[selected]:rounded-none data-[selection-end]:rounded-e-lg data-[selection-start]:rounded-s-lg data-[invalid]:bg-red-100 data-[selected]:bg-accent data-[selected]:text-foreground data-[invalid]:data-[selection-end]:[&:not([data-hover])]:bg-destructive data-[invalid]:data-[selection-start]:[&:not([data-hover])]:bg-destructive data-[selection-end]:[&:not([data-hover])]:bg-primary data-[selection-start]:[&:not([data-hover])]:bg-primary data-[invalid]:data-[selection-end]:[&:not([data-hover])]:text-destructive-foreground data-[invalid]:data-[selection-start]:[&:not([data-hover])]:text-destructive-foreground data-[selection-end]:[&:not([data-hover])]:text-primary-foreground data-[selection-start]:[&:not([data-hover])]:text-primary-foreground",
              // Today indicator styles
              date.compare(now) === 0 &&
                cn(
                  "after:pointer-events-none after:absolute after:bottom-1 after:start-1/2 after:z-10 after:size-[3px] after:-translate-x-1/2 after:rounded-full after:bg-primary",
                  isRange
                    ? "data-[selection-end]:[&:not([data-hover])]:after:bg-background data-[selection-start]:[&:not([data-hover])]:after:bg-background"
                    : "data-[selected]:after:bg-background",
                ),
            )}
          />
        )}
      </CalendarGridBodyRac>
    </CalendarGridRac>
  )
}

const Calendar = ({ className, compact = false, ...props }: CalendarProps) => {
  return (
    <CalendarRac
      {...props}
      className={composeRenderProps(className, (className) =>
        cn("w-fit", className),
      )}
    >
      <CalendarHeader compact={compact} />
      <CalendarGridComponent compact={compact} />
    </CalendarRac>
  )
}

const RangeCalendar = ({ className, compact = false, ...props }: RangeCalendarProps) => {
  return (
    <RangeCalendarRac
      {...props}
      className={composeRenderProps(className, (className) =>
        cn("w-fit", className),
      )}
    >
      <CalendarHeader compact={compact} />
      <CalendarGridComponent isRange compact={compact} />
    </RangeCalendarRac>
  )
}

export { Calendar, RangeCalendar }

