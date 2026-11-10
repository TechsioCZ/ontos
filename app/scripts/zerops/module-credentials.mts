/**
 * The platform's module credentials on a host: who gets one, how a provisioning pass reports them, and how a process
 * that serves several owners receives them. Keys travel only over pipes between processes and live only in their
 * memory; they are never logged, written to disk or put in an environment variable.
 */
import { fromReadable } from '@effect/platform-node/NodeStream';
import { Config, Console, Duration, Effect, Option, Schema, Stream } from 'effect';
import type { Redacted } from 'effect';

import {
  HostedModuleCredentialsSchema,
  ModuleAppIdSchema,
  sealHostedModuleCredentials,
} from '../../packages/core-runtime/src/auth/hosted-module-credentials.ts';

export class ModuleCredentialHandoverError extends Schema.TaggedError<ModuleCredentialHandoverError>()(
  'ModuleCredentialHandoverError',
  { reason: Schema.String },
) {}

/**
 * The modules that call other modules through the Shell's delegated issuance, and so get a module credential. A test
 * derives the same list from source, so a new caller cannot be missed and a former one keeps no key.
 */
export const MODULE_CREDENTIAL_CALLERS: readonly string[] = Object.freeze([
  'catalog',
  'commerce-cart',
  'commerce-customer-context',
  'commerce-market-catalog',
  'commerce-order',
  'crm',
  'party-registry',
  'pricing',
]);

/** Set to `stdin` by whoever hands a multi-owner process its module credentials on its standard input. */
export const MODULE_CREDENTIAL_HANDOVER_VARIABLE = 'ONTOS_MODULE_CREDENTIAL_HANDOVER';

const HandoverJsonSchema = Schema.fromJsonString(HostedModuleCredentialsSchema);

/** A module key's provider id: not secret, it names which bound credential a pass issued. */
const ProviderKeyIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ModuleProviderKeyId'));

/** The bytes a host writes to one multi-owner process: exactly the given owners' credentials, nobody else's. */
export const encodeModuleCredentialHandover = Effect.fn('ModuleCredentials.encodeHandover')(function* encodeHandover(
  credentials: Readonly<Record<string, Redacted.Redacted>>,
  owners: readonly string[],
) {
  const json = yield* Schema.encodeEffect(HandoverJsonSchema)({
    credentials: Object.fromEntries(
      owners.flatMap((owner) => {
        const credential = credentials[owner];
        return credential === undefined ? [] : [[owner, credential] as const];
      }),
    ),
    schemaVersion: 1,
  }).pipe(Effect.mapError(() => new ModuleCredentialHandoverError({ reason: 'The handover could not be encoded' })));
  return new TextEncoder().encode(json);
});

/**
 * Seals this multi-owner process before any owner runs. With the handover flag it reads its owners' credentials from
 * standard input; without it, it seals none, so no owner ever falls back to a module key in the shared environment.
 */
export const receiveModuleCredentialHandover = Effect.gen(function* receiveHandover() {
  // The handover mode is a non-secret switch (`stdin`); the keys arrive on standard input, never in a variable.
  const mode = yield* Config.option(Config.schema(Schema.Literal('stdin'), MODULE_CREDENTIAL_HANDOVER_VARIABLE)).pipe(
    Effect.mapError(
      () => new ModuleCredentialHandoverError({ reason: `${MODULE_CREDENTIAL_HANDOVER_VARIABLE} must be stdin` }),
    ),
  );
  if (Option.isNone(mode)) {
    return yield* sealHostedModuleCredentials({ credentials: {}, schemaVersion: 1 });
  }
  const text = yield* fromReadable<Uint8Array, ModuleCredentialHandoverError>({
    evaluate: () => process.stdin,
    onError: () => new ModuleCredentialHandoverError({ reason: 'The handover could not be read' }),
  }).pipe(Stream.decodeText(), Stream.mkString);
  // Never echo the input: it holds keys.
  const handover = yield* Schema.decodeEffect(HandoverJsonSchema)(text).pipe(
    Effect.mapError(() => new ModuleCredentialHandoverError({ reason: 'The module credential handover is malformed' })),
  );
  yield* sealHostedModuleCredentials(handover);
  return yield* Console.log(
    `[module-credentials] received the credentials of ${Object.keys(handover.credentials).join(', ') || 'no owner'}`,
  );
});

/**
 * What one provisioning pass writes to its standard output for the process that runs it: each module's fresh key, the
 * provider key ids of this pass (not secret; they decide what is superseded) and the modules that got no key.
 */
export const ProvisioningOutputSchema = Schema.Struct({
  credentials: HostedModuleCredentialsSchema.fields.credentials,
  failedAppIds: Schema.Array(ModuleAppIdSchema),
  providerKeyIds: Schema.Array(ProviderKeyIdSchema),
  schemaVersion: Schema.Literal(1),
});
export type ProvisioningOutput = typeof ProvisioningOutputSchema.Type;

/** The wire form of a provisioning pass's output. */
export const ProvisioningOutputJsonSchema = Schema.fromJsonString(ProvisioningOutputSchema);

/** No pass ran: every caller is left without a key and its delegated calls fail closed. */
export const noProvisionedCredentials = (appIds: readonly string[]): ProvisioningOutput => ({
  credentials: {},
  failedAppIds: appIds.map((appId) => ModuleAppIdSchema.make(appId)),
  providerKeyIds: [],
  schemaVersion: 1,
});

/** How long an older host may finish delegated calls it already started once this one took the authority. */
export const MODULE_CREDENTIAL_HANDOVER_GRACE = Duration.minutes(2);
