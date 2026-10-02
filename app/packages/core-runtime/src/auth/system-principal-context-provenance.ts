import { Data, Effect, Predicate, Schema } from 'effect';

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
const provenanceAccessProperty = '__ontosCorePrincipalContextProvenanceAccess';

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
type PrincipalContextProvenanceAccess = (
  candidate: TrustedPrincipalContext,
  token: PrincipalContextProvenanceToken,
) => boolean | object | string;

const PrincipalContextProvenanceAccessSchema = Schema.declare<PrincipalContextProvenanceAccess>(
  (value): value is PrincipalContextProvenanceAccess => Predicate.isFunction(value),
);
const PrincipalContextProvenanceCarrierSchema = Schema.Struct({
  [provenanceAccessProperty]: Schema.optionalKey(PrincipalContextProvenanceAccessSchema),
});

const attachPrincipalContextProvenance = <
  Context extends TrustedPrincipalContext,
  Registration extends object = object,
>(
  context: Context,
  provenance: PrincipalContextProvenanceToken,
  actionRegistration?: Registration,
  compositionRevision?: string,
): Context => {
  const carrier = { ...context };
  const accessProvenance: PrincipalContextProvenanceAccess = (candidate, token) => {
    if (candidate !== carrier || token !== provenance) {
      return false;
    }
    if (provenance === supportRecoveryProvenance) {
      return actionRegistration ?? false;
    }
    return provenance === redeemedGatewayProvenance ? (compositionRevision ?? false) : true;
  };
  Object.defineProperty(carrier, provenanceAccessProperty, {
    value: accessProvenance,
  });
  return Object.isFrozen(context) ? Object.freeze(carrier) : carrier;
};

const hasSystemProvenance = <Context>(context: Context): boolean => {
  if (
    !Schema.is(TrustedPrincipalContextSchema)(context) ||
    !Schema.is(PrincipalContextProvenanceCarrierSchema)(context)
  ) {
    return false;
  }
  const accessProvenance = context[provenanceAccessProperty];
  return accessProvenance?.(context, systemProvenance) === true;
};

const readSupportRecoveryAction = <Context>(context: Context): object | null => {
  if (
    !Schema.is(TrustedPrincipalContextSchema)(context) ||
    !Schema.is(PrincipalContextProvenanceCarrierSchema)(context)
  ) {
    return null;
  }
  const accessProvenance = context[provenanceAccessProperty];
  if (accessProvenance === undefined) {
    return null;
  }
  const registration = accessProvenance(context, supportRecoveryProvenance);
  return Predicate.isObjectKeyword(registration) && registration !== null ? registration : null;
};

const hasRedeemedGatewayProvenance = <Context>(context: Context): boolean => {
  if (
    !Schema.is(TrustedPrincipalContextSchema)(context) ||
    !Schema.is(PrincipalContextProvenanceCarrierSchema)(context)
  ) {
    return false;
  }
  return Schema.is(CompositionRevisionSchema)(context[provenanceAccessProperty]?.(context, redeemedGatewayProvenance));
};

const failProvenanceInvariant = (reason: string): never => {
  throw new PrincipalContextProvenanceInvariant({ reason });
};

export const trustResolvedSystemPrincipalContext = <Context extends TrustedPrincipalContext>(
  context: Context,
): Context => {
  if (!Schema.is(SystemPrincipalContextSchema)(context)) {
    return failProvenanceInvariant('Only resolved system contexts can carry system provenance');
  }
  return attachPrincipalContextProvenance(context, systemProvenance);
};

export const isTrustedSystemPrincipalContext = <Context>(context: Context): boolean =>
  hasSystemProvenance(context) && Schema.is(SystemPrincipalContextSchema)(context);

/** Marks a context only after an audience-bound gateway assertion has been verified and redeemed. */
export const trustVerifiedGatewayPrincipalContext = <Context extends TrustedPrincipalContext>(
  context: Context,
  compositionRevision: string,
): Context => {
  if (!Schema.is(CompositionRevisionSchema)(compositionRevision)) {
    return failProvenanceInvariant('Verified gateway provenance requires its signed composition revision');
  }
  return Object.freeze(
    attachPrincipalContextProvenance(context, redeemedGatewayProvenance, undefined, compositionRevision),
  );
};

/** Returns only the revision carried by this exact verified and redeemed context. */
export const readVerifiedGatewayCompositionRevision = <Context>(context: Context): string | undefined => {
  if (
    !Schema.is(TrustedPrincipalContextSchema)(context) ||
    !Schema.is(PrincipalContextProvenanceCarrierSchema)(context)
  ) {
    return undefined;
  }
  const revision = context[provenanceAccessProperty]?.(context, redeemedGatewayProvenance);
  return Schema.is(CompositionRevisionSchema)(revision) ? revision : undefined;
};

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
  return attachPrincipalContextProvenance(context, supportRecoveryProvenance, actionRegistration);
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
  const gatewayCompositionRevision = readVerifiedGatewayCompositionRevision(source);
  if (gatewayCompositionRevision !== undefined) {
    return trustVerifiedGatewayPrincipalContext(context, gatewayCompositionRevision);
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
