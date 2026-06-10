import { Schema } from 'effect';
import { defineVerticalAction } from '@mvp/shared-contracts';

export const createUnitActionInputSchema = Schema.Struct({
  displayName: Schema.String,
});

export const createUnitActionOutputSchema = Schema.Struct({
  unitId: Schema.String,
});

export const createUnitAction = defineVerticalAction({
  displayName: 'Create property unit',
  id: 'property.registry.createUnit',
  inputSchema: createUnitActionInputSchema,
  outputSchema: createUnitActionOutputSchema,
});
