import type { TrustedPrincipalContext } from '@app/core-runtime';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import type { Crypto } from 'effect';

/**
 * Pricing's one outgoing owner call shape (DESIGN D2). Pricing acts for the verified subject of the
 * request it serves: the scope is the receiving request's own Core-verified principal context.
 */
export class OwnerGatewayConnectionError extends Schema.TaggedError<OwnerGatewayConnectionError>()(
  'OwnerGatewayConnectionError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.String,
  },
) {}

export interface OwnerGatewayConnectionInput {
  readonly audience: string;
  readonly compositionRevision: string;
  readonly legalEntityScope: 'subject' | 'tenant';
  readonly requestCorrelation: string;
  readonly scope: TrustedPrincipalContext;
}

export interface OwnerGatewayConnection {
  readonly baseUrl: URL;
  readonly credential: Redacted.Redacted;
}

/** A credential the Shell already expired is refused here rather than handed to the owner call. */
export const ownerCredentialIsLive = (expiresAt: number, now: DateTime.Utc): boolean =>
  expiresAt * 1000 > DateTime.toEpochMillis(now);

export type OwnerGatewayConnectionAcquire = (
  input: OwnerGatewayConnectionInput,
) => Effect.Effect<OwnerGatewayConnection, OwnerGatewayConnectionError>;

/** A credential is usable only for the active composition revision it was issued under. */
export const ownerConnectionForComposition = (
  issued: { readonly apiBaseUrl: string; readonly compositionRevision: string; readonly credential: Redacted.Redacted },
  compositionRevision: string,
): Effect.Effect<OwnerGatewayConnection, OwnerGatewayConnectionError> =>
  issued.compositionRevision === compositionRevision
    ? Effect.succeed({ baseUrl: new URL(issued.apiBaseUrl), credential: issued.credential })
    : Effect.fail(
        new OwnerGatewayConnectionError({ reason: 'Owner credential belongs to a different active composition' }),
      );

/** Requests a context for the owner module, acting for the subject of `input.scope` through the module credential. */
export const acquireOwnerGatewayConnection = (
  input: OwnerGatewayConnectionInput,
  crypto: Crypto.Crypto,
): Effect.Effect<OwnerGatewayConnection, OwnerGatewayConnectionError> =>
  acquireDelegatedGatewayContext(
    {
      audience: input.audience,
      legalEntityScope: input.legalEntityScope,
      requestCorrelation: input.requestCorrelation,
      subject: { _tag: 'Assertion', scope: input.scope },
    },
    crypto,
  ).pipe(
    Effect.mapError((cause) => new OwnerGatewayConnectionError({ cause, reason: 'Owner gateway is unavailable' })),
    Effect.flatMap((issued) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          ownerCredentialIsLive(issued.expiresAt, now)
            ? ownerConnectionForComposition(
                {
                  apiBaseUrl: issued.apiBaseUrl,
                  compositionRevision: issued.compositionRevision,
                  credential: Redacted.make(issued.authorization),
                },
                input.compositionRevision,
              )
            : Effect.fail(new OwnerGatewayConnectionError({ reason: 'Owner credential expired before use' })),
        ),
      ),
    ),
  );
