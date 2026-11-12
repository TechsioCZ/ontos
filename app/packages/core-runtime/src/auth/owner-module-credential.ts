import { ConfigProvider, Effect, Option, Redacted } from 'effect';

import { hostedSlot, hostedWorkloadSlot } from './hosted-module-credential-store.ts';
import { MODULE_CREDENTIAL_VARIABLE } from './hosted-module-credentials.ts';

/*
 * The one reader of a module's own credential in a process. Only the delegated gateway client imports it
 * (`packages/shared-contracts/src/gateway-context-server.ts`), with the calling module's own topology app id
 * (`scripts/tests/module-credential-reader-boundary.test.mts` holds both).
 */

const credentialValue = (credential: Option.Option<Redacted.Redacted>) =>
  Option.isNone(credential) ? undefined : ConfigProvider.makeValue(Redacted.value(credential.value));

/**
 * The configuration one owner reads, given how to read its hosted slot. In a multi-owner host
 * `ONTOS_GATEWAY_MODULE_API_KEY` resolves to that owner's own slot and to nothing else, never to the shared
 * environment. Without a claim the process serves one module (a dedicated deployment) and reads its own environment,
 * as every module deployment does. All other keys resolve exactly as the given provider resolves them. The slot is
 * read on every lookup, so a key handed over later is seen.
 */
const slotConfigProvider = (
  host: ConfigProvider.ConfigProvider,
  slot: Effect.Effect<Option.Option<Option.Option<Redacted.Redacted>>>,
): ConfigProvider.ConfigProvider =>
  ConfigProvider.make((path) =>
    path.length === 1 && path[0] === MODULE_CREDENTIAL_VARIABLE
      ? slot.pipe(
          Effect.flatMap((hosted) =>
            Option.isNone(hosted) ? host.load(path) : Effect.succeed(credentialValue(hosted.value)),
          ),
        )
      : host.load(path),
  );

/** The same configuration over a given set of hosted credentials (`null`: the process serves one module). */
export const ownerModuleCredentialConfigProvider = (
  host: ConfigProvider.ConfigProvider,
  appId: string,
  slots: () => ReadonlyMap<string, Redacted.Redacted> | null,
): ConfigProvider.ConfigProvider =>
  slotConfigProvider(
    host,
    Effect.sync(() => {
      const hosted = slots();
      return hosted === null ? Option.none() : Option.some(Option.fromNullishOr(hosted.get(appId)));
    }),
  );

/**
 * The owner's configuration in this process: its own slot when the process hosts several owners. The delegated
 * gateway client reads every module credential through it (`acquireDelegatedGatewayContext`), with the calling
 * module's app id, so no runtime, worker or background fiber can reach another owner's key by context.
 */
export const moduleCredentialConfigProvider = (
  host: ConfigProvider.ConfigProvider,
  appId: string,
): ConfigProvider.ConfigProvider => slotConfigProvider(host, hostedSlot(appId));

/**
 * An owner's internal workload credential for one tenant (O73): the key of the principal the operator registered for
 * the owner's own workload there, handed over by the host and rotated like the module key. None in a process the host
 * did not claim, and none for a tenant where the workload is not registered: the caller then fails closed.
 */
export const ownWorkloadCredential = (input: {
  readonly appId: string;
  readonly tenantId: string;
  readonly workloadKey: string;
}): Effect.Effect<Option.Option<Redacted.Redacted>> =>
  hostedWorkloadSlot(`${input.appId}/${input.workloadKey}/${input.tenantId}`);
