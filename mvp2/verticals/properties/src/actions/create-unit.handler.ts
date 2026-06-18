// @effect-diagnostics asyncFunction:off
import type { ActionExecutionServices } from '@mvp2/core-runtime';
import { unit } from '../db/schema.ts';
import type { CreateUnitAction } from './create-unit.action.ts';

export interface CreateUnitResult {
  readonly status: 'ok';
}

export const createUnitHandler = async (
  _input: CreateUnitAction,
  services: ActionExecutionServices<CreateUnitAction>,
): Promise<CreateUnitResult> => {
  await services.tx.insert(unit).values({
    name: 'New unit',
  });

  return {
    status: 'ok',
  };
};
