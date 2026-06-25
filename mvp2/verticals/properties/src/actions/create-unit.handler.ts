// @effect-diagnostics asyncFunction:off
import type { ActionExecutionServices } from '@mvp2/core-runtime';
import { unit } from '../db/schema.ts';
import { propertiesUnitCreatedOutboxMessage } from '../outbox/properties-unit-created.message.ts';
import type { CreateUnitAction, CreateUnitResult } from './create-unit.action.ts';

export const createUnitHandler = async (
  input: CreateUnitAction,
  services: ActionExecutionServices<CreateUnitAction>,
): Promise<CreateUnitResult> => {
  const [inserted] = await services.tx
    .insert(unit)
    .values({
      name: input,
    })
    .returning({
      unitId: unit.unitId,
    });

  if (inserted === undefined) {
    throw new Error('Could not create property unit.');
  }

  services.context.addOutboxMessage?.(
    propertiesUnitCreatedOutboxMessage({
      name: input,
      unitId: inserted.unitId,
    }),
  );

  return {
    status: 'ok',
    unitId: inserted.unitId,
  };
};
