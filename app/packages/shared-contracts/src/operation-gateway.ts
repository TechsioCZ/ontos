import { Effect, Redacted, Schema } from 'effect';
import { ReferenceGatewayCredentialsSchema } from './reference-gateway.ts';

import { DocumentCompositionRevisionError, getDocumentCompositionRevision } from './document-composition-revision.ts';
import { isDocumentAppDenied } from './document-denied-apps.ts';
import { GatewayContextResponseSchema, GatewayForbiddenProblemSchema, issueGatewayContext } from './gateway-context.ts';
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

const deniedAudienceProblem = GatewayForbiddenProblemSchema.make({
  detail: 'The authenticated principal cannot open this module in the current company.',
  status: 403,
  title: 'Gateway context forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});

/**
 * The document session's issuer. An audience the shell's composition found definitely denied fails as the issuer's
 * own GatewayForbiddenProblem without a request (see document-denied-apps.ts); modules still authorize every call.
 */
const skippingDeniedAudiences =
  (
    issuer: OperationGatewayIssuer<string, GatewayContextClientError>,
  ): OperationGatewayIssuer<string, GatewayContextClientError> =>
  (payload, options = {}) =>
    Effect.suspend(() =>
      options.baseUrl === undefined && options.cookie === undefined && isDocumentAppDenied(payload.audience)
        ? Effect.fail(deniedAudienceProblem)
        : issuer(payload, options),
    );

const browserGatewayContextIssuer = skippingDeniedAudiences(issueGatewayContext);

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
  // Generated boundaries can pass the default issuer explicitly. Every invocation
  // still acquires its own single-use assertion, including concurrent attempts.
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
