import { Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ExternalIdentityConflictProblemSchema,
  ExternalIdentityForbiddenProblemSchema,
  ExternalIdentityIneligibleProblemSchema,
  ExternalIdentityInternalProblemSchema,
  ExternalIdentityInvalidProblemSchema,
  ExternalIdentityNotFoundProblemSchema,
  ExternalIdentityThrottledProblemSchema,
  ExternalIdentityUnauthorizedProblemSchema,
  ExternalIdentityUnavailableProblemSchema,
} from '../../src/external-identity.ts';
import {
  GatewayAudienceInvalidProblemSchema,
  GatewayAuthenticationRequiredProblemSchema,
  GatewayForbiddenProblemSchema,
  GatewayInternalProblemSchema,
  GatewayRateLimitedProblemSchema,
  GatewayReloadRequiredProblemSchema,
  GatewayUnavailableProblemSchema,
} from '../../src/gateway-context.ts';
import {
  makeProblemDetailsSchema,
  makeRetryableProblemDetailsSchema,
  problemDetailsContentType,
} from '../../src/problem-details.ts';
import type { ProblemDetailsStatus } from '../../src/problem-details.ts';

type NativeProblemSchema =
  | typeof ExternalIdentityConflictProblemSchema
  | typeof ExternalIdentityForbiddenProblemSchema
  | typeof ExternalIdentityIneligibleProblemSchema
  | typeof ExternalIdentityInternalProblemSchema
  | typeof ExternalIdentityInvalidProblemSchema
  | typeof ExternalIdentityNotFoundProblemSchema
  | typeof ExternalIdentityThrottledProblemSchema
  | typeof ExternalIdentityUnauthorizedProblemSchema
  | typeof ExternalIdentityUnavailableProblemSchema
  | typeof GatewayAudienceInvalidProblemSchema
  | typeof GatewayAuthenticationRequiredProblemSchema
  | typeof GatewayForbiddenProblemSchema
  | typeof GatewayInternalProblemSchema
  | typeof GatewayRateLimitedProblemSchema
  | typeof GatewayReloadRequiredProblemSchema
  | typeof GatewayUnavailableProblemSchema;

type ProblemExtensions = Partial<
  Pick<typeof GatewayRateLimitedProblemSchema.Type, 'retryAfterSeconds'> &
    Pick<typeof GatewayReloadRequiredProblemSchema.Type, 'reloadRequired'> &
    Pick<typeof GatewayUnavailableProblemSchema.Type, 'retryable'>
>;

interface ProblemContractFixture {
  readonly body?: ProblemExtensions;
  readonly extensions?: Readonly<Record<string, Schema.ConstraintCodec<unknown, unknown>>>;
  readonly retryable?: true;
  readonly schema: NativeProblemSchema;
  readonly status: ProblemDetailsStatus;
  readonly tag: string;
}

const fixtures: readonly ProblemContractFixture[] = [
  { schema: GatewayAuthenticationRequiredProblemSchema, status: 401, tag: 'GatewayAuthenticationRequiredProblem' },
  { schema: GatewayAudienceInvalidProblemSchema, status: 400, tag: 'GatewayAudienceInvalidProblem' },
  {
    body: { reloadRequired: true },
    extensions: { reloadRequired: Schema.Literal(true) },
    schema: GatewayReloadRequiredProblemSchema,
    status: 409,
    tag: 'GatewayReloadRequiredProblem',
  },
  { schema: GatewayForbiddenProblemSchema, status: 403, tag: 'GatewayForbiddenProblem' },
  {
    body: { retryAfterSeconds: 30 },
    extensions: { retryAfterSeconds: Schema.Finite },
    schema: GatewayRateLimitedProblemSchema,
    status: 429,
    tag: 'GatewayRateLimitedProblem',
  },
  {
    body: { retryable: true },
    retryable: true,
    schema: GatewayUnavailableProblemSchema,
    status: 503,
    tag: 'GatewayUnavailableProblem',
  },
  { schema: GatewayInternalProblemSchema, status: 500, tag: 'GatewayInternalProblem' },
  { schema: ExternalIdentityInvalidProblemSchema, status: 400, tag: 'ExternalIdentityInvalidProblem' },
  { schema: ExternalIdentityUnauthorizedProblemSchema, status: 401, tag: 'ExternalIdentityUnauthorizedProblem' },
  { schema: ExternalIdentityForbiddenProblemSchema, status: 403, tag: 'ExternalIdentityForbiddenProblem' },
  { schema: ExternalIdentityNotFoundProblemSchema, status: 404, tag: 'ExternalIdentityNotFoundProblem' },
  { schema: ExternalIdentityConflictProblemSchema, status: 409, tag: 'ExternalIdentityConflictProblem' },
  { schema: ExternalIdentityIneligibleProblemSchema, status: 422, tag: 'ExternalIdentityIneligibleProblem' },
  { schema: ExternalIdentityThrottledProblemSchema, status: 429, tag: 'ExternalIdentityThrottledProblem' },
  { schema: ExternalIdentityInternalProblemSchema, status: 500, tag: 'ExternalIdentityInternalProblem' },
  {
    body: { retryable: true },
    retryable: true,
    schema: ExternalIdentityUnavailableProblemSchema,
    status: 503,
    tag: 'ExternalIdentityUnavailableProblem',
  },
];

for (const fixture of fixtures) {
  it(`preserves the native ${fixture.tag} wire contract and HTTP metadata`, () => {
    const actual = fixture.schema;
    const expected =
      fixture.retryable === true
        ? makeRetryableProblemDetailsSchema(fixture.tag, fixture.status, fixture.extensions)
        : makeProblemDetailsSchema(fixture.tag, fixture.status, fixture.extensions);
    const problem = {
      _tag: fixture.tag,
      detail: 'Public contract detail.',
      status: fixture.status,
      title: 'Public contract title',
      type: `urn:ontos:test:${fixture.tag}`,
      ...fixture.body,
    };

    const actualDecoded = Schema.decodeUnknownSync(actual, { onExcessProperty: 'error' })(problem);
    const expectedDecoded = Schema.decodeUnknownSync(expected, { onExcessProperty: 'error' })(problem);
    expect(actualDecoded).toEqual(expectedDecoded);
    expect(Schema.encodeUnknownSync(actual)(actualDecoded)).toEqual(
      Schema.encodeUnknownSync(expected)(expectedDecoded),
    );
    expect(actual.ast.annotations?.['httpApiStatus']).toBe(fixture.status);
    expect(actual.ast.annotations?.['httpApiStatus']).toBe(expected.ast.annotations?.['httpApiStatus']);
    const encoding = actual.ast.annotations?.['~httpApiEncoding'];
    expect(Predicate.isTagged(encoding, 'Json')).toBe(true);
    expect(encoding).toEqual(expected.ast.annotations?.['~httpApiEncoding']);
    expect(encoding).toMatchObject({ contentType: problemDetailsContentType });
    expect(() => Schema.decodeUnknownSync(actual)({ ...problem, status: 418 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(actual, { onExcessProperty: 'error' })({ ...problem, internalDiagnostic: 'private' }),
    ).toThrow();
    if (fixture.retryable === true) {
      expect(() => Schema.decodeUnknownSync(actual)({ ...problem, retryable: false })).toThrow();
    }
    if (fixture.tag === 'GatewayReloadRequiredProblem') {
      expect(() => Schema.decodeUnknownSync(actual)({ ...problem, reloadRequired: false })).toThrow();
    }
  });
}
