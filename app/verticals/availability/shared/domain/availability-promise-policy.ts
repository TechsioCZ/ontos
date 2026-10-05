import { Schema } from 'effect';

import { AvailabilitySubjectSchema, AvailabilityUseBoundarySchema } from './availability-subject.ts';

/**
 * Launch promises the entire unchanged request using Current owner evidence.
 * This is an owner-owned policy value, not an extensible catalogue of future policy switches.
 * Inventory obligations, coverage, sharing and unresolved effects retain their owner meanings.
 */
export const AvailabilityLaunchPromisePolicySchema = Schema.Struct({
  kind: Schema.Literal('LAUNCH_EXACT_QUANTITY'),
  owner: Schema.Literal('AVAILABILITY'),
  revisionRef: Schema.Literal('LAUNCH_EXACT_QUANTITY_V1'),
  subject: AvailabilitySubjectSchema,
  useBoundary: AvailabilityUseBoundarySchema,
});
export type AvailabilityLaunchPromisePolicy = typeof AvailabilityLaunchPromisePolicySchema.Type;
