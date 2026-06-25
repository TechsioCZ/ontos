import { rejectStringStartingWithNewPolicy } from '@mvp2/core-runtime';
import type { ActionRegistration } from '@mvp2/core-runtime';
import { createUnitActionDescriptor } from './create-unit.action.ts';
import type { CreateUnitAction, CreateUnitResult } from './create-unit.action.ts';
import { createUnitHandler } from './create-unit.handler.ts';
import { rejectCreateUnitNameEndingWithUnitPolicy } from './create-unit.policy.ts';

export const createUnitActionRegistration = {
  descriptor: createUnitActionDescriptor,
  handler: createUnitHandler,
  policyChecks: [rejectStringStartingWithNewPolicy, rejectCreateUnitNameEndingWithUnitPolicy],
} satisfies ActionRegistration<CreateUnitAction, CreateUnitResult>;
