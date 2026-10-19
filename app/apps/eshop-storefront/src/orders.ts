import type { PlacedOrder } from './shared/types.ts';

const KEY = 'kavarna-doma.orders.v1';

const readAll = (): Record<string, PlacedOrder> => {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, PlacedOrder>;
  } catch {
    return {};
  }
};

/** Keeps the confirmation of this browser's own DEMO orders so a refresh shows the same number instantly. */
export const rememberOrder = (order: PlacedOrder): void => {
  const all = readAll();
  all[order.submissionId] = order;
  const recent = Object.fromEntries(Object.entries(all).slice(-20));
  window.localStorage.setItem(KEY, JSON.stringify(recent));
};

export const readOrder = (submissionId: string): PlacedOrder | undefined => readAll()[submissionId];
