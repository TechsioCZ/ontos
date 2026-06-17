import type { OperationContext } from '@mvp2/core-runtime';
import type { CreateUnitAction } from './create-unit.action.ts';

export interface CreateUnitResult {
  readonly status: 'ok';
}

export const createUnitHandler = (
  _operationContext: OperationContext<CreateUnitAction>,
): CreateUnitResult => ({
  status: 'ok',
});
