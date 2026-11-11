import { Deferred, Effect, Option } from 'effect';
import type { Redacted } from 'effect';

import { HostedModuleCredentialsSealedError } from './hosted-module-credentials-sealed-error.ts';
import type {
  HostedModuleCredentialAcceptance,
  HostedModuleCredentialReceiver,
  HostedModuleCredentials,
} from './hosted-module-credentials.ts';

/**
 * This process's hosted module credentials, private to this module: no global handle reaches them, and no package
 * export reaches this file. The host imports it by its workspace path (`scripts/zerops/module-credentials.mts`); an
 * owner reaches only its own slot, through `@app/core-runtime/auth/owner-module-credential`, which the delegated
 * gateway client alone imports (`scripts/tests/module-credential-reader-boundary.test.mts`).
 *
 * Claiming the process completes `hostedClaim` once with one write-once slot per served owner; only the claimed
 * receiver fills a slot. Every owner bundle of the process resolves `@app/core-runtime` to this same module file, so
 * they all share these slots
 * (`scripts/tests/hosted-module-credential-instance.test.mts`). The isolation between owners of one process is
 * cooperative: see DEPLOYMENT.md, "Module credentials and bindings".
 */
const hostedClaim = Deferred.makeUnsafe<ReadonlyMap<string, Deferred.Deferred<Redacted.Redacted>>>();

/**
 * Claims this process as a multi-owner host serving `owners`, before any owner runs. From then on each owner reads
 * only its own slot, which starts empty, and never a module key from the shared environment. Claiming twice is
 * refused, so code that runs later cannot obtain a receiver.
 */
export const claimHostedModuleCredentials = Effect.fn('HostedModuleCredentials.claim')(function* claim(
  owners: readonly string[],
) {
  const slots: ReadonlyMap<string, Deferred.Deferred<Redacted.Redacted>> = new Map(
    [...new Set(owners)].map((owner) => [owner, Deferred.makeUnsafe<Redacted.Redacted>()] as const),
  );
  if (!(yield* Deferred.succeed(hostedClaim, slots))) {
    return yield* new HostedModuleCredentialsSealedError({
      reason: 'This process already claimed its hosted module credentials',
    });
  }
  const accept = Effect.fn('HostedModuleCredentials.accept')(function* accept(handover: HostedModuleCredentials) {
    const entries = Object.entries(handover.credentials);
    // A slot is written once: a later handover fills only owners that still hold none, never replaces a key.
    const filled = yield* Effect.forEach(
      entries,
      ([owner, credential]) => {
        const slot = slots.get(owner);
        return slot === undefined ? Effect.succeed(false) : Deferred.succeed(slot, credential);
      },
      { concurrency: 1 },
    );
    return {
      accepted: entries.flatMap(([owner], index) => (filled[index] === true ? [owner] : [])),
      refused: entries.flatMap(([owner], index) => (filled[index] === true ? [] : [owner])),
    } satisfies HostedModuleCredentialAcceptance;
  });
  return { accept, owners: [...slots.keys()] } satisfies HostedModuleCredentialReceiver;
});

/** The owner's slot of a claimed process: `none` when the process serves one module, else its key if it holds one. */
export const hostedSlot = Effect.fn('HostedModuleCredentials.hostedSlot')(function* readHostedSlot(appId: string) {
  const claim = yield* Deferred.poll(hostedClaim);
  if (Option.isNone(claim)) {
    return Option.none<Option.Option<Redacted.Redacted>>();
  }
  const slot = (yield* claim.value).get(appId);
  const held = slot === undefined ? Option.none() : yield* Deferred.poll(slot);
  return Option.some(Option.isNone(held) ? Option.none<Redacted.Redacted>() : Option.some(yield* held.value));
});

/** Which owners of this host hold a credential now; names only, never a key. */
export const heldHostedModuleCredentials = Effect.gen(function* heldCredentials() {
  const claim = yield* Deferred.poll(hostedClaim);
  if (Option.isNone(claim)) {
    return [];
  }
  return [...(yield* claim.value).entries()].flatMap(([owner, slot]) => (Deferred.isDoneUnsafe(slot) ? [owner] : []));
});
