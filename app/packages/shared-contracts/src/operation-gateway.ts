import { Clock, Effect, Redacted, Schema } from 'effect';
import { ReferenceGatewayCredentialsSchema } from './reference-gateway.ts';

import { DocumentCompositionRevisionError, getDocumentCompositionRevision } from './document-composition-revision.ts';
import { GatewayContextResponseSchema, issueGatewayContext } from './gateway-context.ts';
import type {
  GatewayContextClientError,
  GatewayContextClientOptions,
  GatewayContextResponse,
} from './gateway-context.ts';

export type OperationGatewayIssuer<Audience extends string, Failure> = (
  payload: { readonly audience: Audience; readonly compositionRevision: string },
  options?: GatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, Failure>;

export type OperationGatewayAttempt<Success, Failure> = (
  authorizationHeader: string,
  target: Pick<GatewayContextResponse, 'apiBaseUrl' | 'compositionRevision'>,
) => Effect.Effect<Success, Failure>;

// eslint-disable-next-line effect-native/require-context-service-for-service-interface -- This browser gateway is an audience-bound value, not an injectable application service. expires: 2027-03-31.
export interface OperationGateway<IssuerFailure> {
  readonly invoke: <Success, AttemptFailure>(
    attempt: OperationGatewayAttempt<Success, AttemptFailure>,
    options?: GatewayContextClientOptions,
  ) => Effect.Effect<Success, IssuerFailure | AttemptFailure | DocumentCompositionRevisionError | Schema.SchemaError>;
}

// Reuse an issued assertion until shortly before it expires. The shell issuer
// hands out the same token for the same principal/context, and receivers accept
// it repeatedly while valid; caching here removes the per-call round trip.
// Sign-out and tenant/legal-entity switches reload the document, which drops
// this in-memory cache together with the old context.
const ASSERTION_REUSE_MARGIN_MS = 15_000;

// Only the default browser issuer is cached: without a cookie or base URL it
// targets the document's own session. Server callers pass per-request
// credentials and custom issuers own their credentials, so both stay uncached.
const reusingBrowserAssertions = <Audience extends string, IssuerFailure>(
  issuer: OperationGatewayIssuer<Audience, IssuerFailure>,
): OperationGatewayIssuer<Audience, IssuerFailure> => {
  const pending = new Map<string, Effect.Effect<GatewayContextResponse, IssuerFailure>>();
  const fresh = (payload: { readonly audience: Audience; readonly compositionRevision: string }, key: string) =>
    Effect.cached(issuer(payload).pipe(Effect.tapError(() => Effect.sync(() => pending.delete(key))))).pipe(
      Effect.tap((shared) => Effect.sync(() => pending.set(key, shared))),
      Effect.flatten,
    );
  return (payload, options = {}) => {
    if (options.baseUrl !== undefined || options.cookie !== undefined) {
      return issuer(payload, options);
    }
    const key = `${payload.audience}\u0000${payload.compositionRevision}`;
    const shared = pending.get(key);
    if (shared === undefined) {
      return fresh(payload, key);
    }
    return shared.pipe(
      Effect.flatMap((response) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            response.expiresAt * 1000 - now > ASSERTION_REUSE_MARGIN_MS
              ? Effect.succeed(response)
              : fresh(payload, key),
          ),
        ),
      ),
    );
  };
};

const browserGatewayContextIssuer = reusingBrowserAssertions<string, GatewayContextClientError>(issueGatewayContext);

const makeOperationGatewayWithIssuer = <Audience extends string, IssuerFailure>(
  audience: Audience,
  issuer: OperationGatewayIssuer<Audience, IssuerFailure>,
): OperationGateway<IssuerFailure> => {
  const acquireFor = (compositionRevision: string, options: GatewayContextClientOptions) =>
    issuer({ audience, compositionRevision }, options).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GatewayContextResponseSchema, { onExcessProperty: 'error' })),
    );

  return {
    invoke: <Success, AttemptFailure>(
      attempt: OperationGatewayAttempt<Success, AttemptFailure>,
      options: GatewayContextClientOptions = {},
    ) =>
      getDocumentCompositionRevision().pipe(
        Effect.flatMap((documentRevision) =>
          acquireFor(documentRevision, options).pipe(
            Effect.flatMap(
              ({
                apiBaseUrl,
                compositionRevision,
                token,
              }): Effect.Effect<Success, AttemptFailure | DocumentCompositionRevisionError> => {
                if (compositionRevision !== documentRevision) {
                  return Effect.fail(new DocumentCompositionRevisionError({ reason: 'revision-mismatch' }));
                }
                const authorization = Redacted.make(`Bearer ${token}`);
                return attempt(Redacted.value(authorization), { apiBaseUrl, compositionRevision });
              },
            ),
          ),
        ),
      ),
  };
};

export function makeOperationGateway<const Audience extends string>(
  audience: Audience,
): OperationGateway<GatewayContextClientError>;
export function makeOperationGateway<const Audience extends string, IssuerFailure>(
  audience: Audience,
  acquire: OperationGatewayIssuer<Audience, IssuerFailure>,
): OperationGateway<IssuerFailure>;
export function makeOperationGateway<const Audience extends string, IssuerFailure>(
  audience: Audience,
  acquire?: OperationGatewayIssuer<Audience, IssuerFailure>,
): OperationGateway<GatewayContextClientError | IssuerFailure> {
  // Generated action boundaries pass the default issuer explicitly; it still
  // targets the document session, so it shares the browser reuse.
  return acquire === undefined || Object.is(acquire, issueGatewayContext)
    ? makeOperationGatewayWithIssuer(audience, browserGatewayContextIssuer)
    : makeOperationGatewayWithIssuer(audience, acquire);
}

/** Acquire an assertion for every receiving provider audience. */
export const makeReferenceGatewayCredentials = (audiences: readonly string[]) =>
  Effect.forEach(
    audiences,
    (audience) =>
      makeOperationGateway(audience).invoke((authorization) =>
        Effect.succeed({ audience, authorization: Redacted.make(authorization) }),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ReferenceGatewayCredentialsSchema))),
    Effect.map(Redacted.make),
  );
