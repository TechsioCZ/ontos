import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import type { Layer } from 'effect';

import { HostedModuleCredentialsSealedError } from './hosted-module-credentials-sealed-error.ts';

export { HostedModuleCredentialsSealedError } from './hosted-module-credentials-sealed-error.ts';

/** A topology app id, the identity a module credential is bound to. */
export const ModuleAppIdSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,99}$/u)).pipe(
  Schema.brand('ModuleAppId'),
);

/** The variable every module deployment reads as its own module credential. */
export const MODULE_CREDENTIAL_VARIABLE = 'ONTOS_GATEWAY_MODULE_API_KEY';

const MINIMUM_KEY_LENGTH = 16;

/**
 * What a host hands a process that serves several owners: each calling owner's module credential, keyed by its app
 * id. It travels on that process's standard input and is kept only in its memory, never in an environment variable.
 */
export const HostedModuleCredentialsSchema = Schema.Struct({
  credentials: Schema.Record(
    Schema.String,
    Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(MINIMUM_KEY_LENGTH))),
  ).check(
    // Refuse rather than drop: a handover naming something other than a topology app id is not this host's.
    Schema.makeFilter((credentials) =>
      Object.keys(credentials).every(Schema.is(ModuleAppIdSchema)) ? undefined : 'Credentials are keyed by app id',
    ),
  ),
  schemaVersion: Schema.Literal(1),
});
export type HostedModuleCredentials = typeof HostedModuleCredentialsSchema.Type;

/**
 * The process holds its hosted credentials under this key, sealed once and never replaced, so every owner bundle in the
 * process reads the same entries whichever copy of this module it loaded (like the document composition pin).
 */
const hostedCredentialsKey = Symbol.for('ontos.hosted-module-credentials');

const HostedCredentialsPinSchema = Schema.Record(Schema.String, Schema.Redacted(Schema.String));

const readHostedCredentials = (): ReadonlyMap<string, Redacted.Redacted> | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, hostedCredentialsKey);
  const pinned: unknown = descriptor?.value;
  return descriptor === undefined ||
    descriptor.configurable !== false ||
    descriptor.writable !== false ||
    !Schema.is(HostedCredentialsPinSchema)(pinned)
    ? undefined
    : new Map(Object.entries(pinned));
};

/**
 * Seals this process as a multi-owner host with exactly these credentials. From then on each owner reads only its own
 * entry; an owner without one has no module credential. Sealing twice is refused, so a later caller cannot swap keys.
 */
export const sealHostedModuleCredentials = Effect.fn('HostedModuleCredentials.seal')(function* seal(
  credentials: HostedModuleCredentials,
) {
  if (Object.getOwnPropertyDescriptor(globalThis, hostedCredentialsKey) !== undefined) {
    return yield* new HostedModuleCredentialsSealedError({
      reason: 'This process already holds its hosted module credentials',
    });
  }
  return yield* Effect.try({
    catch: (cause) =>
      new HostedModuleCredentialsSealedError({ cause, reason: 'The hosted module credentials could not be sealed' }),
    try: () => {
      Object.defineProperty(globalThis, hostedCredentialsKey, {
        configurable: false,
        enumerable: false,
        value: Object.freeze({ ...credentials.credentials }),
        writable: false,
      });
    },
  });
});

/** Whether this process was sealed as a multi-owner host. */
export const isHostedModuleCredentialProcess = (): boolean => readHostedCredentials() !== undefined;

/**
 * The configuration one owner reads. Given a multi-owner host's credentials, `ONTOS_GATEWAY_MODULE_API_KEY` resolves to
 * that owner's own entry and to nothing else, never to the shared environment. Without them the process serves one
 * module (a dedicated deployment) and reads its own environment, as every module deployment does. All other keys
 * resolve exactly as the given provider resolves them.
 */
export const ownerModuleCredentialConfigProvider = (
  host: ConfigProvider.ConfigProvider,
  appId: string,
  hosted: () => ReadonlyMap<string, Redacted.Redacted> | null | undefined,
): ConfigProvider.ConfigProvider =>
  ConfigProvider.make((path) => {
    const credentials = hosted();
    if (
      credentials !== undefined &&
      credentials !== null &&
      path.length === 1 &&
      path[0] === MODULE_CREDENTIAL_VARIABLE
    ) {
      const credential = credentials.get(appId);
      return Effect.succeed(
        credential === undefined ? undefined : ConfigProvider.makeValue(Redacted.value(credential)),
      );
    }
    return host.load(path);
  });

/** The owner's configuration in this process, read against the credentials this process was sealed with. */
export const moduleCredentialConfigProvider = (
  host: ConfigProvider.ConfigProvider,
  appId: string,
): ConfigProvider.ConfigProvider => ownerModuleCredentialConfigProvider(host, appId, readHostedCredentials);

/** The owner's configuration overlay, for the runtime layer of a module that calls other modules. */
export const moduleCredentialOverlay = (appId: string): Layer.Layer<never> =>
  ConfigProvider.layer(
    Effect.gen(function* ownerModuleCredentialOverlay() {
      return moduleCredentialConfigProvider(yield* ConfigProvider.ConfigProvider, appId);
    }),
  );
