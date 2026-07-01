import type { ListAccountingAction, ListAccountingResult } from './list-accounting.action.ts';

export const listAccountingHandler = (_input: ListAccountingAction): ListAccountingResult => ({
  items: [],
});
