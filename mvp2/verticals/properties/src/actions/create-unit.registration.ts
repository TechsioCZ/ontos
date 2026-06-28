import type { ActionRegistration } from '@mvp2/core-runtime';
import { createUnitActionDescriptor } from './create-unit.action.ts';
import type { CreateUnitAction, CreateUnitResult } from './create-unit.action.ts';
import { createUnitHandler } from './create-unit.handler.ts';
import {
  rejectCreateUnitNameEndingWithUnitPolicy,
  rejectCreateUnitNameStartingWithNewPolicy,
} from './create-unit.policy.ts';

export const createUnitActionRegistration = {
  descriptor: createUnitActionDescriptor,
  handler: createUnitHandler,
  policyChecks: [
    rejectCreateUnitNameStartingWithNewPolicy,
    rejectCreateUnitNameEndingWithUnitPolicy,
  ],
} satisfies ActionRegistration<CreateUnitAction, CreateUnitResult>;
