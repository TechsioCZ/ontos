import { Effect, Schema, Predicate } from 'effect';

import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';

const SystemPrincipalContextSchema = Schema.Struct({
  authMethod: Schema.Literal('system'),
});
const SessionPrincipalContextSchema = Schema.Struct({
  authMethod: Schema.Literal('session'),
});
const systemProvenance = Object.freeze({ kind: 'system' });
const supportRecoveryProvenance = Object.freeze({ kind: 'support_recovery' });
const redeemedGatewayProvenance = Object.freeze({ kind: 'redeemed_gateway' });
const provenanceAccessProperty = '__ontosCorePrincipalContextProvenanceAccess';

const PrincipalContextProvenanceInvariant = Schema.TaggedError<Error>()('PrincipalContextProvenanceInvariant', {
  reason: Schema.String,
});

export class TrustedPrincipalContextDecodeError extends Schema.TaggedError<TrustedPrincipalContextDecodeError>()(
  'TrustedPrincipalContextDecodeError',
  {},
) {}

type PrincipalContextProvenanceToken =
  | typeof supportRecoveryProvenance
  | typeof systemProvenance
  | typeof redeemedGatewayProvenance;
type PrincipalContextProvenanceAccess = (
  candidate: TrustedPrincipalContext,
  token: PrincipalContextProvenanceToken,
) => boolean | object;

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
): Context => {
  const carrier = { ...context };
  const accessProvenance: PrincipalContextProvenanceAccess = (candidate, token) => {
    if (candidate !== carrier || token !== provenance) {
      return false;
    }
    return provenance === supportRecoveryProvenance ? (actionRegistration ?? false) : true;
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
  return context[provenanceAccessProperty]?.(context, redeemedGatewayProvenance) === true;
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
): Context => attachPrincipalContextProvenance(context, redeemedGatewayProvenance);

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
  if (isVerifiedGatewayPrincipalContext(source)) {
    return trustVerifiedGatewayPrincipalContext(context);
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
    return Effect.fail(new TrustedPrincipalContextDecodeError());
  }
  if (
    Schema.is(TrustedPrincipalContextSchema)(input) &&
    input.trustedStorefrontId !== undefined &&
    !isVerifiedGatewayPrincipalContext(input)
  ) {
    return Effect.fail(new TrustedPrincipalContextDecodeError());
  }
  return Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(input).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(new TrustedPrincipalContextDecodeError(), 'cause', {
        value: cause,
      }),
    ),
    Effect.map((context) => preserveSystemPrincipalContextTrust(input, context)),
  );
};
