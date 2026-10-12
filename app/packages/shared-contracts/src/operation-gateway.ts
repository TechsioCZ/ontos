import { Effect, Redacted, Schema } from 'effect';
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

const makeOperationGatewayWithIssuer = <Audience extends string, IssuerFailure>(
  audience: Audience,
  issuer: OperationGatewayIssuer<Audience, IssuerFailure>,
): OperationGateway<IssuerFailure> => ({
  invoke: <Success, AttemptFailure>(
    attempt: OperationGatewayAttempt<Success, AttemptFailure>,
    options: GatewayContextClientOptions = {},
  ) =>
    getDocumentCompositionRevision().pipe(
      Effect.flatMap((documentRevision) =>
        issuer({ audience, compositionRevision: documentRevision }, options).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(GatewayContextResponseSchema, { onExcessProperty: 'error' })),
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
});

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
  return acquire === undefined
    ? makeOperationGatewayWithIssuer(audience, issueGatewayContext)
    : makeOperationGatewayWithIssuer(audience, acquire);
}

/** Acquire a separate single-use assertion for every receiving provider attempt. */
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
