import { Effect, Schema } from 'effect';
import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';

export class TrustedPrincipalContextDecodeError extends Schema.TaggedErrorClass<TrustedPrincipalContextDecodeError>()(
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

export const isTrustedSystemPrincipalContext = (context: unknown): boolean =>
  typeof context === 'object' &&
  context !== null &&
  trustedSystemContexts.has(context) &&
  'authMethod' in context &&
  context.authMethod === 'system';

export const trustSupportRecoveryPrincipalContext = <Context extends TrustedPrincipalContext>(
  context: Context,
  actionRegistration: object,
): Context => {
  if (context.authMethod !== 'session') {
    throw new TypeError('Only resolved session contexts can carry support recovery provenance');
  }
  trustedSupportRecoveryContexts.set(context, actionRegistration);
  return context;
};

export const isTrustedSupportRecoveryPrincipalContext = (
  context: unknown,
  actionRegistration?: object,
): boolean => {
  if (typeof context !== 'object' || context === null) {
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

export const preserveSystemPrincipalContextTrust = <Context extends TrustedPrincipalContext>(
  source: unknown,
  context: Context,
): Context => {
  if (isTrustedSystemPrincipalContext(source)) {
    return trustResolvedSystemPrincipalContext(context);
  }
  if (typeof source === 'object' && source !== null) {
    const recoveryActionRegistration = trustedSupportRecoveryContexts.get(source);
    if (recoveryActionRegistration !== undefined) {
      return trustSupportRecoveryPrincipalContext(context, recoveryActionRegistration);
    }
  }
  return context;
};

export const decodeTrustedPrincipalContext = (
  input: unknown,
): Effect.Effect<TrustedPrincipalContext, TrustedPrincipalContextDecodeError> => {
  if (
    typeof input === 'object' &&
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
