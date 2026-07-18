import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Merge Tailwind classes with conflict resolution. The standard shadcn/ui
 * helper — composes clsx (conditional) with tailwind-merge (dedupe + last-
 * wins for conflicting utilities).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
