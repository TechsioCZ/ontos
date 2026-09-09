import { Effect, Redacted } from 'effect';

import { issueGatewayContext } from './gateway-context.ts';
import type {
  GatewayContextClientError,
  GatewayContextClientOptions,
  GatewayContextResponse,
} from './gateway-context.ts';

export type OperationGatewayIssuer<Audience extends string, Failure> = (
  payload: { readonly audience: Audience },
  options?: GatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, Failure>;

export type OperationGatewayAttempt<Success, Failure> = (
  authorizationHeader: string,
) => Effect.Effect<Success, Failure>;

// eslint-disable-next-line effect-native/require-context-service-for-service-interface -- This browser gateway is an audience-bound value, not an injectable application service. expires: 2027-03-31.
export interface OperationGateway<IssuerFailure> {
  readonly invoke: <Success, AttemptFailure>(
    attempt: OperationGatewayAttempt<Success, AttemptFailure>,
    options?: GatewayContextClientOptions,
  ) => Effect.Effect<Success, IssuerFailure | AttemptFailure>;
}

const makeOperationGatewayWithIssuer = <Audience extends string, IssuerFailure>(
  audience: Audience,
  issuer: OperationGatewayIssuer<Audience, IssuerFailure>,
): OperationGateway<IssuerFailure> => ({
  invoke: <Success, AttemptFailure>(
    attempt: OperationGatewayAttempt<Success, AttemptFailure>,
    options: GatewayContextClientOptions = {},
  ) =>
    Effect.suspend(() => issuer({ audience }, options)).pipe(
      Effect.flatMap(({ token }) => {
        const authorization = Redacted.make(`Bearer ${token}`);
        return attempt(Redacted.value(authorization));
      }),
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
