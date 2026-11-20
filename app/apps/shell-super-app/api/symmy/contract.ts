import {
  GatewayAuthenticationRequiredProblemSchema,
  GatewayForbiddenProblemSchema,
  GatewayRateLimitedProblemSchema,
  GatewayUnavailableProblemSchema,
} from '@app/shared-contracts';
import type { GatewayInternalProblemSchema } from '@app/shared-contracts';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { SymmyItemOutcomeSchema, SymmySourceRecordKeySchema } from '@app/shared-contracts/symmy';
import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema, SchemaTransformation } from 'effect';
import { HttpApiMiddleware } from 'effect/http-api';

import {
  SymmyEncodedSourceCodeSchema,
  SymmySelectedSourceCodeSchema,
} from '@app/symmy-integration/symmy-source-selector';

const SymmyInvalidProblemSchema = makeProblemDetailsSchema('SymmyInvalidProblem', 400);
const SymmyFixtureJobNotFoundProblemSchema = makeProblemDetailsSchema('SymmyFixtureJobNotFoundProblem', 404);
const SymmyFixtureIntentConflictProblemSchema = makeProblemDetailsSchema('SymmyFixtureIntentConflictProblem', 409);
const SymmyIdempotencyRequiredProblemSchema = makeProblemDetailsSchema('SymmyIdempotencyRequiredProblem', 428);
const SymmyUnsupportedProblemSchema = makeProblemDetailsSchema('SymmyUnsupportedProblem', 422, {
  reason: Schema.Literals([
    'projection_not_configured',
    'filter_not_supported',
    'owner_field_not_supported',
    'search_too_broad',
  ]),
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
/** Paging fields shared by every read route, so each route's own query schema pages the same way. */
export const symmyReadLimitSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 100, minimum: 1 }),
);
export const symmyReadOffsetSchema = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const SymmyInternalReadQuerySchema = Schema.Struct({
  afterRecordId: Schema.optionalKey(Schema.toEncoded(SymmySourceRecordKeySchema.fields.sourceRecordId)),
  code: Schema.optionalKey(
    Schema.Union([
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
      Schema.toEncoded(SymmyEncodedSourceCodeSchema),
    ]),
  ),
  contractVersion: Schema.optionalKey(Schema.Literal('INTERNAL_C14')),
  limit: Schema.optionalKey(symmyReadLimitSchema),
  offset: Schema.optionalKey(symmyReadOffsetSchema),
  priceLimit: Schema.optionalKey(symmyReadLimitSchema),
  priceOffset: Schema.optionalKey(symmyReadOffsetSchema),
  sourceRecordId: Schema.optionalKey(Schema.toEncoded(SymmySourceRecordKeySchema.fields.sourceRecordId)),
});
/** The public `GET /price-lists` query. Neither `code` nor `contractVersion` is a parameter. */
export const SymmyPriceListsReadQuerySchema = Schema.Struct({
  limit: Schema.optionalKey(symmyReadLimitSchema),
  offset: Schema.optionalKey(symmyReadOffsetSchema),
  priceLimit: Schema.optionalKey(symmyReadLimitSchema),
  priceOffset: Schema.optionalKey(symmyReadOffsetSchema),
});
/** A comma-separated `fields` list decoded to its names; one name outside the route's own list gives 400. */
const symmyFieldsQuerySchema = (maxLength: number, isName: (name: string) => boolean, description: string) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxLength)).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform<readonly string[], string>({
        decode: (value) => value.split(','),
        encode: (names) => names.join(','),
      }),
    ),
    Schema.check(Schema.makeFilter((names: readonly string[]) => names.every(isName), { description })),
  );
const SymmyRegionFieldNameSchema = Schema.Literals([
  'countryCodes',
  'currencyCode',
  'id',
  'marketCode',
  'marketRef',
  'sourceRecordId',
]);
export type SymmyRegionFieldName = typeof SymmyRegionFieldNameSchema.Type;
export const isSymmyRegionFieldName = Schema.is(SymmyRegionFieldNameSchema);
/** The public `GET /admin/regions` query. `contractVersion` is never a parameter: the route sets it. */
export const SymmyRegionsReadQuerySchema = Schema.Struct({
  fields: Schema.optionalKey(
    symmyFieldsQuerySchema(200, isSymmyRegionFieldName, 'A comma-separated list of region field names.'),
  ),
  limit: Schema.optionalKey(symmyReadLimitSchema),
  offset: Schema.optionalKey(symmyReadOffsetSchema),
  q: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});
/** The selectable item paths of `GET /admin/products`. `id` is always returned and is not selectable. */
const SymmyProductFieldNameSchema = Schema.Literals([
  'product',
  'product.catalogReady',
  'product.createdAt',
  'product.description',
  'product.lifecycle',
  'product.name',
  'product.productRef',
  'product.revision',
  'product.updatedAt',
  'product.variants',
  'sourceRecordId',
  'variantSources',
]);
export type SymmyProductFieldName = typeof SymmyProductFieldNameSchema.Type;
export const isSymmyProductFieldName = Schema.is(SymmyProductFieldNameSchema);
/** The public `GET /admin/products` query: paging, `q` and `fields` only. No cursor, `code` or `contractVersion`. */
export const SymmyProductsReadQuerySchema = Schema.Struct({
  fields: Schema.optionalKey(
    symmyFieldsQuerySchema(500, isSymmyProductFieldName, 'A comma-separated list of product field paths.'),
  ),
  limit: Schema.optionalKey(symmyReadLimitSchema),
  offset: Schema.optionalKey(symmyReadOffsetSchema),
  q: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});
/** The selectable item parts of `GET /admin/customers`. The first four are always returned. */
const SymmyCustomerFieldNameSchema = Schema.Literals([
  'businessName',
  'ico',
  'id',
  'party',
  'partyRef',
  'profile',
  'sourceRecordId',
]);
export type SymmyCustomerFieldName = typeof SymmyCustomerFieldNameSchema.Type;
export const isSymmyCustomerFieldName = Schema.is(SymmyCustomerFieldNameSchema);
/** The public `GET /admin/customers` query: paging, `q` and `fields` only. No cursor, `code` or `contractVersion`. */
export const SymmyCustomersReadQuerySchema = Schema.Struct({
  fields: Schema.optionalKey(
    symmyFieldsQuerySchema(200, isSymmyCustomerFieldName, 'A comma-separated list of customer part names.'),
  ),
  limit: Schema.optionalKey(symmyReadLimitSchema),
  offset: Schema.optionalKey(symmyReadOffsetSchema),
  q: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
});
export const SymmyFixtureIdSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)).pipe(
  Schema.brand('SymmyFixtureId'),
);
export const SymmyFixtureSubmitPayloadSchema = Schema.Struct({ fixtureId: SymmyFixtureIdSchema });
export const symmyCodeParams = Schema.Struct({
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
  status: Schema.Literal('queued'),
});
export const SymmyFixtureJobStatusSchema = Schema.Union([
  Schema.Struct({
    items: Schema.optionalKey(Schema.Array(fixtureItemResult)),
    jobId: SymmyFixtureJobIdSchema,
    status: Schema.Literals(['queued', 'running', 'blocked']),
  }),
  Schema.Struct({
    items: fixtureItems,
    jobId: SymmyFixtureJobIdSchema,
    status: Schema.Literals(['completed_all', 'completed_partial', 'completed_none', 'indeterminate']),
  }),
]);

const base = { error: ingressProblems, headers, query };
export const symmyReadOptions = { ...base, query: SymmyInternalReadQuerySchema, success: SymmyFixtureReadSchema };
export const symmyWriteOptions = {
  ...base,
  error: [...ingressProblems, SymmyIdempotencyRequiredProblemSchema, SymmyFixtureIntentConflictProblemSchema],
  headers: Schema.Struct({
    ...authenticationHeaders,
    'idempotency-key': Schema.optionalKey(SymmyClientIdempotencyKeySchema),
  }),
};
export const symmySubmitOptions = {
  ...base,
  error: [...ingressProblems, SymmyFixtureIntentConflictProblemSchema],
  headers: submitHeaders,
  success: SymmyFixtureAdmissionSchema.pipe(HttpApiSchema.status(202)),
};

export const symmyFixtureSubmitOptions = {
  ...symmySubmitOptions,
  payload: SymmyFixtureSubmitPayloadSchema,
};

export const symmyJobOptions = {
  ...base,
  error: [...ingressProblems, SymmyFixtureJobNotFoundProblemSchema],
  params: jobParams,
  success: SymmyFixtureJobStatusSchema,
};
