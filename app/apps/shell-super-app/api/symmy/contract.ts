import {
  GatewayAuthenticationRequiredProblemSchema,
  GatewayForbiddenProblemSchema,
  GatewayRateLimitedProblemSchema,
  GatewayUnavailableProblemSchema,
} from '@app/shared-contracts';
import type { GatewayInternalProblemSchema } from '@app/shared-contracts';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { SYMMY_ROUTES, SymmyItemOutcomeSchema, SymmySourceRecordKeySchema } from '@app/shared-contracts/symmy';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';
import { HttpApiMiddleware, OpenApi } from 'effect/http-api';

import { SymmyDefectBoundary } from './defect-boundary.ts';
import { SymmyInternalRegionsProjectionSchema } from './regions-projection-contract.ts';
import {
  SymmyEncodedSourceCodeSchema,
  SymmySelectedSourceCodeSchema,
} from '@app/symmy-integration/symmy-source-selector';
import {
  SymmyInternalProductsProjectionSchema,
  SymmyInternalPriceListsProjectionSchema,
  SymmyInternalCustomersProjectionSchema,
} from './read-projection-contracts.ts';

const SymmyInvalidProblemSchema = makeProblemDetailsSchema('SymmyInvalidProblem', 400);
const SymmyFixtureJobNotFoundProblemSchema = makeProblemDetailsSchema('SymmyFixtureJobNotFoundProblem', 404);
const SymmyFixtureIntentConflictProblemSchema = makeProblemDetailsSchema('SymmyFixtureIntentConflictProblem', 409);
const SymmyIdempotencyRequiredProblemSchema = makeProblemDetailsSchema('SymmyIdempotencyRequiredProblem', 428);
const SymmyUnsupportedProblemSchema = makeProblemDetailsSchema('SymmyUnsupportedProblem', 422, {
  reason: Schema.Literals(['projection_not_configured', 'filter_not_supported', 'owner_field_not_supported']),
});
export const SymmyUnavailableProblemSchema = makeRetryableProblemDetailsSchema('SymmyUnavailableProblem', 503);
export const SymmyMethodNotAllowedProblemSchema = makeProblemDetailsSchema('SymmyMethodNotAllowedProblem', 405);

export const symmyInvalidProblem = SymmyInvalidProblemSchema.make({
  detail: 'The integration request does not match the declared internal fixture contract.',
  status: SymmyInvalidProblemSchema.fields.status.literal,
  title: 'Invalid integration request',
  type: 'https://ontos.dev/problems/symmy-invalid',
});

export class SymmySchemaError extends HttpApiMiddleware.Service<SymmySchemaError>()(
  '@app/shell-super-app/api/symmy/contract/SymmySchemaError',
  { error: SymmyInvalidProblemSchema },
) {}

export const symmyUnavailableProblem = SymmyUnavailableProblemSchema.make({
  detail: 'The requested integration operation is unavailable.',
  retryable: true,
  status: SymmyUnavailableProblemSchema.fields.status.literal,
  title: 'Integration unavailable',
  type: 'https://ontos.dev/problems/symmy-unavailable',
});

export const symmyMethodNotAllowedProblem = SymmyMethodNotAllowedProblemSchema.make({
  detail: 'This integration path does not support the requested method.',
  status: SymmyMethodNotAllowedProblemSchema.fields.status.literal,
  title: 'Integration method not allowed',
  type: 'https://ontos.dev/problems/symmy-method-not-allowed',
});

export const symmyFixtureJobNotFoundProblem = SymmyFixtureJobNotFoundProblemSchema.make({
  detail: 'The requested integration job was not found.',
  status: SymmyFixtureJobNotFoundProblemSchema.fields.status.literal,
  title: 'Integration job not found',
  type: 'https://ontos.dev/problems/symmy-job-not-found',
});

export const symmyFixtureIntentConflictProblem = SymmyFixtureIntentConflictProblemSchema.make({
  detail: 'The integration idempotency key is already bound to a different request.',
  status: SymmyFixtureIntentConflictProblemSchema.fields.status.literal,
  title: 'Integration request conflict',
  type: 'https://ontos.dev/problems/symmy-intent-conflict',
});

export const symmyIdempotencyRequiredProblem = SymmyIdempotencyRequiredProblemSchema.make({
  detail: 'An idempotency key is required for an internal integration write.',
  status: SymmyIdempotencyRequiredProblemSchema.fields.status.literal,
  title: 'Integration idempotency key required',
  type: 'https://ontos.dev/problems/symmy-idempotency-required',
});

export const symmyUnsupportedProblem = (reason: typeof SymmyUnsupportedProblemSchema.Type.reason) =>
  SymmyUnsupportedProblemSchema.make({
    detail: 'The requested field or projection has no configured native owner mapping.',
    reason,
    status: SymmyUnsupportedProblemSchema.fields.status.literal,
    title: 'Unsupported integration projection',
    type: 'https://ontos.dev/problems/symmy-unsupported',
  });

const ingressProblems = [
  GatewayAuthenticationRequiredProblemSchema,
  GatewayForbiddenProblemSchema,
  GatewayRateLimitedProblemSchema,
  GatewayUnavailableProblemSchema,
  SymmyUnavailableProblemSchema,
  SymmyInvalidProblemSchema,
  SymmyUnsupportedProblemSchema,
];
export type SymmyIngressProblem = (typeof ingressProblems)[number]['Type'] | typeof GatewayInternalProblemSchema.Type;

const authenticationHeaders = {
  'x-api-key': Schema.optionalKey(Schema.String),
};
const headers = Schema.Struct(authenticationHeaders);
export const SymmyClientIdempotencyKeySchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,200}$/u)).pipe(
  Schema.brand('SymmyClientIdempotencyKey'),
);
const submitHeaders = Schema.Struct({
  ...authenticationHeaders,
  'idempotency-key': SymmyClientIdempotencyKeySchema,
});
const query = Schema.Struct({}).check(Schema.isMaxProperties(0));
export const SymmyInternalReadQuerySchema = Schema.Struct({
  afterRecordId: Schema.optionalKey(Schema.toEncoded(SymmySourceRecordKeySchema.fields.sourceRecordId)),
  code: Schema.optionalKey(
    Schema.Union([
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
      Schema.toEncoded(SymmyEncodedSourceCodeSchema),
    ]),
  ),
  contractVersion: Schema.optionalKey(Schema.Literal('INTERNAL_C14')),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum: 100, minimum: 1 })),
  ),
  offset: Schema.optionalKey(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  priceLimit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum: 100, minimum: 1 })),
  ),
  priceOffset: Schema.optionalKey(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  sourceRecordId: Schema.optionalKey(Schema.toEncoded(SymmySourceRecordKeySchema.fields.sourceRecordId)),
});
export const SymmyFixtureIdSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)).pipe(
  Schema.brand('SymmyFixtureId'),
);
export const SymmyInternalPlanPayloadSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  plan: SymmyInternalExecutionPlanSchema,
});
export const SymmyInternalWritePayloadSchema = Schema.Union([
  Schema.Struct({ fixtureId: SymmyFixtureIdSchema }),
  SymmyInternalPlanPayloadSchema,
]);
const codeParams = Schema.Struct({
  code: SymmySelectedSourceCodeSchema,
});
export const SymmyFixtureJobIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyJobId'));
const jobParams = Schema.Struct({ id: SymmyFixtureJobIdSchema });

const fixtureItemResult = Schema.Struct({
  ...SymmyItemOutcomeSchema.fields,
  outcome: Schema.Literals(['accepted', 'partial', 'not_accepted']),
});
const fixtureItems = Schema.NonEmptyArray(fixtureItemResult);
export const SymmyFixtureReadSchema = Schema.Struct({ references: Schema.Array(Schema.String.check(Schema.isUUID())) });
export const SymmyFixtureItemResultsSchema = Schema.Struct({ items: fixtureItems });
export const SymmyFixtureAdmissionSchema = Schema.Struct({
  jobId: SymmyFixtureJobIdSchema,
  status: Schema.Literal('admitted'),
});
export const SymmyFixtureJobStatusSchema = Schema.Union([
  Schema.Struct({
    items: Schema.optionalKey(Schema.Array(fixtureItemResult)),
    jobId: SymmyFixtureJobIdSchema,
    status: Schema.Literals(['admitted', 'running', 'blocked']),
  }),
  Schema.Struct({
    items: fixtureItems,
    jobId: SymmyFixtureJobIdSchema,
    status: Schema.Literals(['completed_all', 'completed_partial', 'completed_none', 'indeterminate']),
  }),
]);

const base = { error: ingressProblems, headers, query };
const read = { ...base, query: SymmyInternalReadQuerySchema, success: SymmyFixtureReadSchema };
const write = {
  ...base,
  error: [...ingressProblems, SymmyIdempotencyRequiredProblemSchema, SymmyFixtureIntentConflictProblemSchema],
  headers: Schema.Struct({
    ...authenticationHeaders,
    'idempotency-key': Schema.optionalKey(SymmyClientIdempotencyKeySchema),
  }),
  payload: SymmyInternalWritePayloadSchema,
  success: SymmyFixtureItemResultsSchema,
};
const submit = {
  ...base,
  error: [...ingressProblems, SymmyFixtureIntentConflictProblemSchema],
  headers: submitHeaders,
  payload: SymmyInternalWritePayloadSchema,
  success: SymmyFixtureAdmissionSchema.pipe(HttpApiSchema.status(202)),
};

const nativeSymmyPath = (path: `/${string}`): `/${string}` =>
  `/${path.slice(1).replace('{code}', ':code').replace('{id}', ':id')}`;

const adminCustomersEndpoint = HttpApiEndpoint.get('adminCustomers', SYMMY_ROUTES.adminCustomers.path, {
  ...read,
  success: Schema.Union([SymmyFixtureReadSchema, SymmyInternalCustomersProjectionSchema]),
});
const adminProductsEndpoint = HttpApiEndpoint.get('adminProducts', SYMMY_ROUTES.adminProducts.path, {
  ...read,
  success: Schema.Union([SymmyFixtureReadSchema, SymmyInternalProductsProjectionSchema]),
});
const adminRegionsEndpoint = HttpApiEndpoint.get('adminRegions', SYMMY_ROUTES.adminRegions.path, {
  ...read,
  success: Schema.Union([SymmyFixtureReadSchema, SymmyInternalRegionsProjectionSchema]),
});
const customerGroupCustomersBatchEndpoint = HttpApiEndpoint.post(
  'customerGroupCustomersBatch',
  nativeSymmyPath(SYMMY_ROUTES.customerGroupCustomersBatch.path),
  { ...submit, params: codeParams },
);
const customerGroupsBatchEndpoint = HttpApiEndpoint.post(
  'customerGroupsBatch',
  SYMMY_ROUTES.customerGroupsBatch.path,
  write,
);
const customersBatchEndpoint = HttpApiEndpoint.post('customersBatch', SYMMY_ROUTES.customersBatch.path, submit);
const inventoryStockBatchEndpoint = HttpApiEndpoint.post(
  'inventoryStockBatch',
  SYMMY_ROUTES.inventoryStockBatch.path,
  write,
);
const jobEndpoint = HttpApiEndpoint.get('job', nativeSymmyPath(SYMMY_ROUTES.job.path), {
  ...base,
  error: [...ingressProblems, SymmyFixtureJobNotFoundProblemSchema],
  params: jobParams,
  success: SymmyFixtureJobStatusSchema,
});
const priceListPricesBatchEndpoint = HttpApiEndpoint.post(
  'priceListPricesBatch',
  nativeSymmyPath(SYMMY_ROUTES.priceListPricesBatch.path),
  {
    ...submit,
    params: codeParams,
  },
);
const priceListsEndpoint = HttpApiEndpoint.get('priceLists', SYMMY_ROUTES.priceLists.path, {
  ...read,
  success: Schema.Union([SymmyFixtureReadSchema, SymmyInternalPriceListsProjectionSchema]),
});
const priceListsBatchUpsertEndpoint = HttpApiEndpoint.post(
  'priceListsBatchUpsert',
  SYMMY_ROUTES.priceListsBatchUpsert.path,
  submit,
);
const productsBatchEndpoint = HttpApiEndpoint.post('productsBatch', SYMMY_ROUTES.productsBatch.path, submit);

type SymmyIngressEndpoints = HttpApiEndpoint.AddMiddleware<
  HttpApiEndpoint.AddMiddleware<
    | typeof adminCustomersEndpoint
    | typeof adminProductsEndpoint
    | typeof adminRegionsEndpoint
    | typeof customerGroupCustomersBatchEndpoint
    | typeof customerGroupsBatchEndpoint
    | typeof customersBatchEndpoint
    | typeof inventoryStockBatchEndpoint
    | typeof jobEndpoint
    | typeof priceListPricesBatchEndpoint
    | typeof priceListsEndpoint
    | typeof priceListsBatchUpsertEndpoint
    | typeof productsBatchEndpoint,
    SymmySchemaError
  >,
  SymmyDefectBoundary
>;

export interface SymmyIngressGroupContract extends HttpApiGroup.HttpApiGroup<'symmy', SymmyIngressEndpoints> {
  readonly identifier: 'symmy';
}

/** Internal fixture inputs and outputs. The real wire DTO and governed owner response require their own acceptance. */
export const SymmyIngressGroup: SymmyIngressGroupContract = HttpApiGroup.make('symmy')
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error' })
  .annotate(HttpApi.QueryParseOptions, { onExcessProperty: 'error' })
  // Shell's OpenAPI describes endpoints callable through the normal Shell mount.
  .annotate(OpenApi.Exclude, true)
  .add(
    adminCustomersEndpoint,
    adminProductsEndpoint,
    adminRegionsEndpoint,
    customerGroupCustomersBatchEndpoint,
    customerGroupsBatchEndpoint,
    customersBatchEndpoint,
    inventoryStockBatchEndpoint,
    jobEndpoint,
    priceListPricesBatchEndpoint,
    priceListsEndpoint,
    priceListsBatchUpsertEndpoint,
    productsBatchEndpoint,
  )
  .middleware(SymmySchemaError)
  .middleware(SymmyDefectBoundary);
