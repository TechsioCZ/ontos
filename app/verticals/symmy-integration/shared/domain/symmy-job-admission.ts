import { Schema } from 'effect';
import { SymmyDurableJobRouteKeySchema, SymmyJobIdSchema } from './symmy-job-identities.ts';
import { SymmyInternalExecutionPlanSchema } from './symmy-job-execution.ts';
import { SymmyCatalogHeadSchema, SymmyPriceListRowsSchema } from './symmy-price-list-batch.ts';

import { SymmyPolicyFixtureRouteKeySchema } from './symmy-policy-fixture-intents.ts';

export { SymmyJobIdSchema } from './symmy-job-identities.ts';

const codedRoutes = Schema.Literals(['customerGroupCustomersBatch', 'priceListPricesBatch']);
const SymmyFixtureIdSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)).pipe(
  Schema.brand('SymmyFixtureId'),
);
const SymmyClientIdempotencyKeySchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,200}$/u)).pipe(
  Schema.brand('SymmyClientIdempotencyKey'),
);

export const AdmitSymmyJobPayloadSchema = Schema.Struct({
  /** The tenant catalog head read for the request. It fences the first created price list and is not caller intent. */
  catalogHead: Schema.optionalKey(SymmyCatalogHeadSchema),
  code: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300))),
  contractVersion: Schema.optionalKey(Schema.Literal('INTERNAL_C14')),
  fixtureId: Schema.optionalKey(SymmyFixtureIdSchema),
  idempotencyKey: SymmyClientIdempotencyKeySchema,
  plan: Schema.optionalKey(SymmyInternalExecutionPlanSchema),
  /** The public price list rows. The route enrollment, not the caller, supplies every other price fact. */
  priceLists: Schema.optionalKey(SymmyPriceListRowsSchema),
  routeKey: SymmyDurableJobRouteKeySchema,
}).check(
  Schema.makeFilter(
    ({ catalogHead, code, contractVersion, fixtureId, plan, priceLists, routeKey }) =>
      (routeKey === 'priceListsBatchUpsert'
        ? priceLists !== undefined &&
          catalogHead !== undefined &&
          code === undefined &&
          fixtureId === undefined &&
          contractVersion === undefined &&
          plan === undefined
        : priceLists === undefined &&
          catalogHead === undefined &&
          ((fixtureId !== undefined && contractVersion === undefined && plan === undefined) ||
            (fixtureId === undefined &&
              contractVersion === 'INTERNAL_C14' &&
              plan !== undefined &&
              !Schema.is(SymmyPolicyFixtureRouteKeySchema)(routeKey))) &&
          Schema.is(codedRoutes)(routeKey) === (code !== undefined)) ||
      'Fixture routes require a fixture ID, only selected durable routes require a code, and price lists go only to the price list route',
  ),
);
export type AdmitSymmyJobPayload = typeof AdmitSymmyJobPayloadSchema.Type;

export const AdmitSymmyJobResultSchema = Schema.Struct({
  jobId: SymmyJobIdSchema,
  phase: Schema.Literal('admitted'),
});

export class AdmitSymmyJobRejected extends Schema.TaggedError<AdmitSymmyJobRejected>()('AdmitSymmyJobRejected', {
  code: Schema.Literals(['symmy_job_intent_conflict', 'symmy_job_persistence_unavailable', 'symmy_job_route_denied']),
  reason: Schema.String,
}) {}
