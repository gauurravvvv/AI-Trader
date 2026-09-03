import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class names, resolving conflicts (last-wins) via tailwind-merge.
 * The shadcn/ui `cn` helper — every `ui/` component imports it from `@/lib/utils`.
 * It lived in a shared workspace lib in the original monorepo and was not carried
 * over in the Replit export, which is one of the reasons the app failed to build.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
