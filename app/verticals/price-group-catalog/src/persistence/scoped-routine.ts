import { defineScopedRoutine } from '@app/core-runtime';
import { Schema } from 'effect';

const PriceGroupRoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });
export type PriceGroupRoutineRow = typeof PriceGroupRoutineRowSchema.Type;

const ownerModuleKey = 'pricing.price-group-catalog';
const schema = 'price_group_catalog';
const tenant = { source: 'tenantId', type: 'uuid' } as const;

export const createPriceGroupRoutine = defineScopedRoutine({
  name: 'create_price_group_with_complete_schedule',
  ownerModuleKey,
  parameters: [tenant, { source: 'input', type: 'jsonb' }],
  resultSchema: PriceGroupRoutineRowSchema,
  routineKey: 'catalog.create-price-group',
  schema,
});

export const createDefinitionRevisionRoutine = defineScopedRoutine({
  name: 'create_definition_revision_with_continuity',
  ownerModuleKey,
  parameters: [tenant, { source: 'input', type: 'jsonb' }],
  resultSchema: PriceGroupRoutineRowSchema,
  routineKey: 'catalog.create-definition-revision',
  schema,
});

export const retirePriceGroupRoutine = defineScopedRoutine({
  name: 'retire_price_group',
  ownerModuleKey,
  parameters: [tenant, { source: 'input', type: 'jsonb' }],
  resultSchema: PriceGroupRoutineRowSchema,
  routineKey: 'catalog.retire-price-group',
  schema,
});

export const readCurrentDefinitionRoutine = defineScopedRoutine({
  name: 'read_current_definition_with_retirement',
  ownerModuleKey,
  parameters: [tenant, { source: 'input', type: 'uuid' }, { source: 'input', type: 'timestamptz' }],
  resultSchema: PriceGroupRoutineRowSchema,
  routineKey: 'catalog.read-current-definition',
  schema,
});

export const readDefinitionRevisionRoutine = defineScopedRoutine({
  name: 'read_definition_revision_with_retirement',
  ownerModuleKey,
  parameters: [
    tenant,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
  ],
  resultSchema: PriceGroupRoutineRowSchema,
  routineKey: 'catalog.read-definition-revision',
  schema,
});

export const validateCompatibilityRoutine = defineScopedRoutine({
  name: 'validate_compatibility',
  ownerModuleKey,
  parameters: [
    tenant,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'bigint' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: PriceGroupRoutineRowSchema,
  routineKey: 'catalog.validate-compatibility',
  schema,
});
