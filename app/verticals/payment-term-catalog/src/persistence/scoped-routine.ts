import { defineScopedRoutine } from '@app/core-runtime';
import { Schema } from 'effect';

const PaymentTermRoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });
export type PaymentTermRoutineRow = typeof PaymentTermRoutineRowSchema.Type;

const ownerModuleKey = 'payment.term-catalog';
const schema = 'payment_term_catalog';

export const getCurrentPaymentTermRoutine = defineScopedRoutine({
  name: 'get_current',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: PaymentTermRoutineRowSchema,
  routineKey: 'catalog.get-current',
  schema,
});

export const createPaymentTermRoutine = defineScopedRoutine({
  name: 'create_term',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: PaymentTermRoutineRowSchema,
  routineKey: 'catalog.create',
  schema,
});

export const correctPaymentTermRoutine = defineScopedRoutine({
  name: 'correct_term',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: PaymentTermRoutineRowSchema,
  routineKey: 'catalog.correct',
  schema,
});

export const retirePaymentTermRoutine = defineScopedRoutine({
  name: 'retire_term',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: PaymentTermRoutineRowSchema,
  routineKey: 'catalog.retire',
  schema,
});

export const reconcilePaymentTermRoutine = defineScopedRoutine({
  name: 'reconcile_term',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: PaymentTermRoutineRowSchema,
  routineKey: 'catalog.reconcile',
  schema,
});

export const getPaymentTermHistoryRoutine = defineScopedRoutine({
  name: 'get_history',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: PaymentTermRoutineRowSchema,
  routineKey: 'catalog.get-history',
  schema,
});

export const listCurrentPaymentTermsRoutine = defineScopedRoutine({
  name: 'list_current',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'timestamptz' },
  ],
  resultSchema: PaymentTermRoutineRowSchema,
  routineKey: 'catalog.list-current',
  schema,
});

export const resolvePaymentTermReferenceRoutine = defineScopedRoutine({
  name: 'resolve_reference',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
    { nullable: true, source: 'input', type: 'text' },
  ],
  resultSchema: PaymentTermRoutineRowSchema,
  routineKey: 'catalog.resolve-reference',
  schema,
});
