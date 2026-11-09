import { Schema } from 'effect';
import { SymmyDurableJobRouteKeySchema, SymmyJobIdSchema } from './symmy-job-identities.ts';
import { SymmyInternalExecutionPlanSchema } from './symmy-job-execution.ts';

export { SymmyJobIdSchema } from './symmy-job-identities.ts';

const codedRoutes = Schema.Literals(['customerGroupCustomersBatch', 'priceListPricesBatch']);
const SymmyFixtureIdSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)).pipe(
  Schema.brand('SymmyFixtureId'),
);
const SymmyClientIdempotencyKeySchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,200}$/u)).pipe(
  Schema.brand('SymmyClientIdempotencyKey'),
);

export const AdmitSymmyJobPayloadSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300))),
  contractVersion: Schema.optionalKey(Schema.Literal('INTERNAL_C14')),
  fixtureId: Schema.optionalKey(SymmyFixtureIdSchema),
  idempotencyKey: SymmyClientIdempotencyKeySchema,
  plan: Schema.optionalKey(SymmyInternalExecutionPlanSchema),
  routeKey: SymmyDurableJobRouteKeySchema,
}).check(
  Schema.makeFilter(
    ({ code, contractVersion, fixtureId, plan, routeKey }) =>
      (((fixtureId !== undefined && contractVersion === undefined && plan === undefined) ||
        (fixtureId === undefined && contractVersion === 'INTERNAL_C14' && plan !== undefined)) &&
        Schema.is(codedRoutes)(routeKey) === (code !== undefined)) ||
      'Only selected durable routes require a code',
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
