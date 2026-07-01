import type { ActionRegistration } from '@mvp2/core-runtime/sdk';
import { readUnitsActionDescriptor } from './read-units.action.ts';
import type { ReadUnitsAction } from './read-units.action.ts';
import { readUnitsHandler } from './read-units.handler.ts';
import type { ReadUnitsResult } from './read-units.handler.ts';

export const readUnitsActionRegistration = {
  descriptor: readUnitsActionDescriptor,
  handler: readUnitsHandler,
  policyChecks: [],
} satisfies ActionRegistration<ReadUnitsAction, ReadUnitsResult>;
