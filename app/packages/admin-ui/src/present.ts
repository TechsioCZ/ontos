import type { ReactNode } from 'react';

/** True when a ReactNode slot has something to render. */
export const isPresent = (node: ReactNode): boolean =>
  node !== undefined && node !== null && node !== false && node !== '';
