import { Effect, Schema, Predicate } from 'effect';
import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';

export class TrustedPrincipalContextDecodeError extends Schema.TaggedError<TrustedPrincipalContextDecodeError>()(
  'TrustedPrincipalContextDecodeError',
  {},
) {}

const trustedSystemContexts = new WeakSet<object>();
const trustedSupportRecoveryContexts = new WeakMap<object, object>();

export const trustResolvedSystemPrincipalContext = <Context extends TrustedPrincipalContext>(
  context: Context,
): Context => {
  if (context.authMethod !== 'system') {
    throw new TypeError('Only resolved system contexts can carry system provenance');
  }
  trustedSystemContexts.add(context);
  return context;
};

export const isTrustedSystemPrincipalContext = <Context>(context: Context): boolean =>
  Predicate.isObjectKeyword(context) &&
  context !== null &&
  trustedSystemContexts.has(context) &&
  'authMethod' in context &&
  context.authMethod === 'system';

export const trustSupportRecoveryPrincipalContext = <
  Context extends TrustedPrincipalContext,
  Registration extends object,
>(
  context: Context,
  actionRegistration: Registration,
): Context => {
  if (context.authMethod !== 'session') {
    throw new TypeError('Only resolved session contexts can carry support recovery provenance');
  }
  trustedSupportRecoveryContexts.set(context, actionRegistration);
  return context;
};

export const isTrustedSupportRecoveryPrincipalContext = <
  Context,
  Registration extends object = object,
>(
  context: Context,
  actionRegistration?: Registration,
): boolean => {
  if (!Predicate.isObjectKeyword(context) || context === null) {
    return false;
  }
  const trustedActionRegistration = trustedSupportRecoveryContexts.get(context);
  return (
    trustedActionRegistration !== undefined &&
    (actionRegistration === undefined || trustedActionRegistration === actionRegistration) &&
    'authMethod' in context &&
    context.authMethod === 'session'
  );
};

export const preserveSystemPrincipalContextTrust = <
  Source,
  Context extends TrustedPrincipalContext,
>(
  source: Source,
  context: Context,
): Context => {
  if (isTrustedSystemPrincipalContext(source)) {
    return trustResolvedSystemPrincipalContext(context);
  }
  if (Predicate.isObjectKeyword(source) && source !== null) {
    const recoveryActionRegistration = trustedSupportRecoveryContexts.get(source);
    if (recoveryActionRegistration !== undefined) {
      return trustSupportRecoveryPrincipalContext(context, recoveryActionRegistration);
    }
  }
  return context;
};

export const decodeTrustedPrincipalContext = <Input>(
  input: Input,
): Effect.Effect<TrustedPrincipalContext, TrustedPrincipalContextDecodeError> => {
  if (
    Predicate.isObjectKeyword(input) &&
    input !== null &&
    'authMethod' in input &&
    input.authMethod === 'system' &&
    !isTrustedSystemPrincipalContext(input)
  ) {
    return Effect.fail(new TrustedPrincipalContextDecodeError());
  }
  return Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(input).pipe(
    Effect.mapError(() => new TrustedPrincipalContextDecodeError()),
    Effect.map((context) => preserveSystemPrincipalContextTrust(input, context)),
  );
};
