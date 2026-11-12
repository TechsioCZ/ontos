import { Deferred, Effect, Option, Ref } from 'effect';
import type { Redacted } from 'effect';

import { HostedModuleCredentialsSealedError } from './hosted-module-credentials-sealed-error.ts';
import type {
  HostedModuleCredentialAcceptance,
  HostedModuleCredentialReceiver,
  HostedModuleCredentials,
} from './hosted-module-credentials.ts';
import { workloadEntryAppId } from './hosted-module-credentials.ts';

type Slot = Ref.Ref<Option.Option<Redacted.Redacted>>;

/**
 * This process's hosted module credentials, private to this module: no global handle reaches them, and no package
 * export reaches this file. The host imports it by its workspace path (`scripts/zerops/module-credentials.mts`); an
 * owner reaches only its own slot, through `@app/core-runtime/auth/owner-module-credential`, which the delegated
 * gateway client alone imports (`scripts/tests/module-credential-reader-boundary.test.mts`).
 *
 * Claiming the process completes `hostedClaim` once with one slot per served owner; only the claimed receiver, fed by
 * the host's private channel, fills or replaces a slot. Every owner bundle of the process resolves `@app/core-runtime`
 * to this same module file, so they all share these slots (`scripts/tests/hosted-module-credential-instance.test.mts`). The isolation between owners of one process is
 * cooperative: see DEPLOYMENT.md, "Module credentials and bindings".
 */
interface HostedSlots {
  readonly owners: ReadonlyMap<string, Slot>;
  /** The owners' internal workload credentials, by `<app id>/<workload key>/<tenant id>`. */
  readonly workloads: Ref.Ref<ReadonlyMap<string, Redacted.Redacted>>;
}

const hostedClaim = Deferred.makeUnsafe<HostedSlots>();

/**
 * Claims this process as a multi-owner host serving `owners`, before any owner runs. From then on each owner reads
 * only its own slot, which starts empty, and never a module key from the shared environment. Claiming twice is
 * refused, so code that runs later cannot obtain a receiver.
 */
export const claimHostedModuleCredentials = Effect.fn('HostedModuleCredentials.claim')(function* claim(
  owners: readonly string[],
) {
  const slots: ReadonlyMap<string, Slot> = new Map(
    [...new Set(owners)].map((owner) => [owner, Ref.makeUnsafe(Option.none<Redacted.Redacted>())] as const),
  );
  const workloads = Ref.makeUnsafe<ReadonlyMap<string, Redacted.Redacted>>(new Map());
  if (!(yield* Deferred.succeed(hostedClaim, { owners: slots, workloads }))) {
    return yield* new HostedModuleCredentialsSealedError({
      reason: 'This process already claimed its hosted module credentials',
    });
  }
  const accept = Effect.fn('HostedModuleCredentials.accept')(function* accept(handover: HostedModuleCredentials) {
    const entries = Object.entries(handover.credentials);
    // The host's channel is the only writer and delivers in order: each handover gives the named owners their current
    // key, a first one or a replacement (a fresh key after a revocation, a rotated one). Strangers are refused.
    const filled = yield* Effect.forEach(
      entries,
      ([owner, credential]) => {
        const slot = slots.get(owner);
        return slot === undefined
          ? Effect.succeed(false)
          : Ref.set(slot, Option.some(credential)).pipe(Effect.as(true));
      },
      { concurrency: 1 },
    );
    // A handover carries each owner it names with its complete set of workload credentials: they replace all the
    // owner held before, so a workload the operator no longer registers is dropped.
    const workloadEntries = Object.entries(handover.workloads ?? {});
    const served = workloadEntries.filter(([entry]) => slots.has(workloadEntryAppId(entry)));
    const renewedOwners = new Set([
      ...entries.flatMap(([owner]) => (slots.has(owner) ? [owner] : [])),
      ...served.map(([entry]) => workloadEntryAppId(entry)),
    ]);
    yield* Ref.update(
      workloads,
      (held) => new Map([...[...held].filter(([entry]) => !renewedOwners.has(workloadEntryAppId(entry))), ...served]),
    );
    return {
      accepted: [
        ...entries.flatMap(([owner], index) => (filled[index] === true ? [owner] : [])),
        ...served.map(([entry]) => entry),
      ],
      refused: [
        ...entries.flatMap(([owner], index) => (filled[index] === true ? [] : [owner])),
        ...workloadEntries.flatMap(([entry]) => (slots.has(workloadEntryAppId(entry)) ? [] : [entry])),
      ],
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
  const slot = (yield* claim.value).owners.get(appId);
  return Option.some(slot === undefined ? Option.none<Redacted.Redacted>() : yield* Ref.get(slot));
});

/** An owner's internal workload credential in one tenant, if the host handed one over; none outside a claimed host. */
export const hostedWorkloadSlot = Effect.fn('HostedModuleCredentials.hostedWorkloadSlot')(function* readWorkloadSlot(
  entry: string,
) {
  const claim = yield* Deferred.poll(hostedClaim);
  if (Option.isNone(claim)) {
    return Option.none<Redacted.Redacted>();
  }
  return Option.fromUndefinedOr((yield* Ref.get((yield* claim.value).workloads)).get(entry));
});

/** Which owners of this host hold a credential now; names only, never a key. */
export const heldHostedModuleCredentials = Effect.gen(function* heldCredentials() {
  const claim = yield* Deferred.poll(hostedClaim);
  if (Option.isNone(claim)) {
    return [];
  }
  const slots = [...(yield* claim.value).owners.entries()];
  return slots.flatMap(([owner, slot]) => (Option.isSome(Ref.getUnsafe(slot)) ? [owner] : []));
});
