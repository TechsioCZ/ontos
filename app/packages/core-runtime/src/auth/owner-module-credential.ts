import type { Effect, Option, Redacted } from 'effect';

import { hostedSlot, hostedWorkloadSlot } from './hosted-module-credential-store.ts';

/*
 * The one reader of a module's own credentials in a process. Only the delegated gateway client imports it
 * (`packages/shared-contracts/src/gateway-context-server.ts`), with the calling module's own topology app id
 * (`scripts/tests/module-credential-reader-boundary.test.mts` holds both). Keys come only from the host's private
 * channel; there is no environment variable to read one from.
 */

/**
 * The module's own module credential, read on every call so a key handed over later (late, renewed, rotated) is seen.
 * None while the host has not claimed this module's copy or handed it no key: the caller then fails closed.
 */
export const ownModuleCredential = (appId: string): Effect.Effect<Option.Option<Redacted.Redacted>> =>
  hostedSlot(appId);

/**
 * An owner's internal workload credential for one tenant (O73): the key of the principal the operator registered for
 * the owner's own workload there, handed over by the host and rotated like the module key. None where the host
 * handed none over, and none for a tenant where the workload is not registered: the caller then fails closed.
 */
export const ownWorkloadCredential = (input: {
  readonly appId: string;
  readonly tenantId: string;
  readonly workloadKey: string;
}): Effect.Effect<Option.Option<Redacted.Redacted>> =>
  hostedWorkloadSlot(`${input.appId}/${input.workloadKey}/${input.tenantId}`);
