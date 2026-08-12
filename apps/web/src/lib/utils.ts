import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Class-name joiner every shadcn component imports. twMerge resolves Tailwind
 * conflicts last-wins (`px-2 px-4` → `px-4`), which is what lets a caller
 * override a component's built-in classes via its className prop.
 *
 * Only for Tailwind classes. Existing components use CSS modules and should
 * keep composing their styles with template strings.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
