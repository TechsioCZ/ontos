import type { ActionRegistration } from '@mvp2/core-runtime/sdk';
import { listAccountingActionDescriptor } from './list-accounting.action.ts';
import type { ListAccountingAction, ListAccountingResult } from './list-accounting.action.ts';
import { listAccountingHandler } from './list-accounting.handler.ts';

export const listAccountingActionRegistration = {
  descriptor: listAccountingActionDescriptor,
  handler: listAccountingHandler,
} satisfies ActionRegistration<ListAccountingAction, ListAccountingResult>;
