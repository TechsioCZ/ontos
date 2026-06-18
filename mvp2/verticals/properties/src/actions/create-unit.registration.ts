import type { ActionRegistration } from '@mvp2/core-runtime';
import { type CreateUnitAction, createUnitActionDescriptor } from './create-unit.action.ts';
import { type CreateUnitResult, createUnitHandler } from './create-unit.handler.ts';

export const createUnitActionRegistration = {
  descriptor: createUnitActionDescriptor,
  handler: createUnitHandler,
} satisfies ActionRegistration<CreateUnitAction, CreateUnitResult>;
