import { Data, Effect, Schema } from 'effect';
import type { Redacted } from 'effect';

import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';

const SystemPrincipalContextSchema = Schema.Struct({
  authMethod: Schema.Literal('system'),
});
const SessionPrincipalContextSchema = Schema.Struct({
  authMethod: Schema.Literal('session'),
});
const CompositionRevisionSchema = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));
const systemProvenance = Object.freeze({ kind: 'system' });
const supportRecoveryProvenance = Object.freeze({ kind: 'support_recovery' });
const redeemedGatewayProvenance = Object.freeze({ kind: 'redeemed_gateway' });

/**
 * The redeemed gateway assertion a trusted database scope can be established from. It lives only in
 * the module-private provenance store, so it is never a property of, or serialized with, the context.
 */
export interface GatewayScopeAssertion {
  readonly assertion: Redacted.Redacted;
  readonly audience: string;
}

interface RedeemedGatewayProvenance {
  readonly compositionRevision: string;
  readonly scopeAssertion?: GatewayScopeAssertion;
}

const GatewayScopeAssertionSchema = Schema.Struct({
  assertion: Schema.Redacted(Schema.String),
  audience: Schema.String.check(Schema.isMinLength(1)),
});

const PrincipalContextProvenanceInvariant = Schema.TaggedError<Error>()('PrincipalContextProvenanceInvariant', {
  reason: Schema.String,
});

export class TrustedPrincipalContextDecodeError extends Data.TaggedError('TrustedPrincipalContextDecodeError')<{
  readonly cause?: unknown;
}> {}

type PrincipalContextProvenanceToken =
  | typeof supportRecoveryProvenance
  | typeof systemProvenance
  | typeof redeemedGatewayProvenance;

interface PrincipalContextProvenance {
  readonly actionRegistration?: object;
  readonly redeemedGateway?: RedeemedGatewayProvenance;
  readonly token: PrincipalContextProvenanceToken;
}

/**
 * Provenance keyed by the exact carrier object this module created. Nothing outside the module can
 * add an entry, and a copy of a carrier (spread, decode, structured clone) is a new object without one.
 */
// oxlint-disable-next-line effect-native/no-unmanaged-mutable-state -- WeakMap entries are transient capability metadata keyed by carrier objects.
const principalContextProvenance = new WeakMap<object, PrincipalContextProvenance>();

const attachPrincipalContextProvenance = <Context extends TrustedPrincipalContext>(
  context: Context,
  provenance: PrincipalContextProvenance,
): Context => {
  const carrier = { ...context };
  principalContextProvenance.set(carrier, Object.freeze(provenance));
  return Object.isFrozen(context) ? Object.freeze(carrier) : carrier;
};

const readPrincipalContextProvenance = <Context>(
  context: Context,
  token: PrincipalContextProvenanceToken,
): PrincipalContextProvenance | undefined => {
  if (!Schema.is(TrustedPrincipalContextSchema)(context)) {
    return undefined;
  }
  const provenance = principalContextProvenance.get(context);
  return provenance?.token === token ? provenance : undefined;
};

const hasSystemProvenance = <Context>(context: Context): boolean =>
  readPrincipalContextProvenance(context, systemProvenance) !== undefined;

const readSupportRecoveryAction = <Context>(context: Context): object | null =>
  readPrincipalContextProvenance(context, supportRecoveryProvenance)?.actionRegistration ?? null;

const readRedeemedGatewayProvenance = <Context>(context: Context): RedeemedGatewayProvenance | undefined =>
  readPrincipalContextProvenance(context, redeemedGatewayProvenance)?.redeemedGateway;

const hasRedeemedGatewayProvenance = <Context>(context: Context): boolean =>
  readRedeemedGatewayProvenance(context) !== undefined;

const failProvenanceInvariant = (reason: string): never => {
  throw new PrincipalContextProvenanceInvariant({ reason });
};

export const trustResolvedSystemPrincipalContext = <Context extends TrustedPrincipalContext>(
  context: Context,
): Context => {
  if (!Schema.is(SystemPrincipalContextSchema)(context)) {
    return failProvenanceInvariant('Only resolved system contexts can carry system provenance');
  }
  return attachPrincipalContextProvenance(context, { token: systemProvenance });
};

export const isTrustedSystemPrincipalContext = <Context>(context: Context): boolean =>
  hasSystemProvenance(context) && Schema.is(SystemPrincipalContextSchema)(context);

/**
 * Marks a context only after an audience-bound gateway assertion has been verified and redeemed. The
 * optional scope assertion is the redeemed token a trusted database scope is established from.
 */
export const trustVerifiedGatewayPrincipalContext = <Context extends TrustedPrincipalContext>(
  context: Context,
  compositionRevision: string,
  scopeAssertion?: GatewayScopeAssertion,
): Context => {
  if (!Schema.is(CompositionRevisionSchema)(compositionRevision)) {
    return failProvenanceInvariant('Verified gateway provenance requires its signed composition revision');
  }
  if (scopeAssertion !== undefined && !Schema.is(GatewayScopeAssertionSchema)(scopeAssertion)) {
    return failProvenanceInvariant('A gateway scope assertion requires its audience and redacted assertion');
  }
  const redeemedGateway: RedeemedGatewayProvenance = Object.freeze(
    scopeAssertion === undefined
      ? { compositionRevision }
      : {
          compositionRevision,
          scopeAssertion: Object.freeze({ assertion: scopeAssertion.assertion, audience: scopeAssertion.audience }),
        },
  );
  return Object.freeze(
    attachPrincipalContextProvenance(context, { redeemedGateway, token: redeemedGatewayProvenance }),
  );
};

/** Returns only the revision carried by this exact verified and redeemed context. */
export const readVerifiedGatewayCompositionRevision = <Context>(context: Context): string | undefined =>
  readRedeemedGatewayProvenance(context)?.compositionRevision;

/** Returns the redeemed gateway assertion carried by this exact verified context, if any. */
export const readVerifiedGatewayScopeAssertion = <Context>(context: Context): GatewayScopeAssertion | undefined =>
  readRedeemedGatewayProvenance(context)?.scopeAssertion;

export const isVerifiedGatewayPrincipalContext = <Context>(context: Context): boolean =>
  hasRedeemedGatewayProvenance(context);

export const trustSupportRecoveryPrincipalContext = <
  Context extends TrustedPrincipalContext,
  Registration extends object,
>(
  context: Context,
  actionRegistration: Registration,
): Context => {
  if (!Schema.is(SessionPrincipalContextSchema)(context)) {
    return failProvenanceInvariant('Only resolved session contexts can carry support recovery provenance');
  }
  return attachPrincipalContextProvenance(context, { actionRegistration, token: supportRecoveryProvenance });
};

export const isTrustedSupportRecoveryPrincipalContext = <Context, Registration extends object = object>(
  context: Context,
  actionRegistration?: Registration,
): boolean => {
  const trustedActionRegistration = readSupportRecoveryAction(context);
  return (
    trustedActionRegistration !== null &&
    (actionRegistration === undefined || trustedActionRegistration === actionRegistration) &&
    Schema.is(SessionPrincipalContextSchema)(context)
  );
};

export const preserveSystemPrincipalContextTrust = <Source, Context extends TrustedPrincipalContext>(
  source: Source,
  context: Context,
): Context => {
  if (isTrustedSystemPrincipalContext(source)) {
    return trustResolvedSystemPrincipalContext(context);
  }
  const redeemedGateway = readRedeemedGatewayProvenance(source);
  if (redeemedGateway !== undefined) {
    return trustVerifiedGatewayPrincipalContext(
      context,
      redeemedGateway.compositionRevision,
      redeemedGateway.scopeAssertion,
    );
  }
  const recoveryActionRegistration = readSupportRecoveryAction(source);
  if (recoveryActionRegistration !== null) {
    return trustSupportRecoveryPrincipalContext(context, recoveryActionRegistration);
  }
  return context;
};

export const decodeTrustedPrincipalContext = <Input>(
  input: Input,
): Effect.Effect<TrustedPrincipalContext, TrustedPrincipalContextDecodeError> => {
  if (Schema.is(SystemPrincipalContextSchema)(input) && !isTrustedSystemPrincipalContext(input)) {
    return Effect.fail(new TrustedPrincipalContextDecodeError({}));
  }
  if (
    Schema.is(TrustedPrincipalContextSchema)(input) &&
    input.trustedStorefrontId !== undefined &&
    !isVerifiedGatewayPrincipalContext(input)
  ) {
    return Effect.fail(new TrustedPrincipalContextDecodeError({}));
  }
  return Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(input).pipe(
    Effect.mapError((cause) => new TrustedPrincipalContextDecodeError({ cause })),
    Effect.map((context) => preserveSystemPrincipalContextTrust(input, context)),
  );
};
