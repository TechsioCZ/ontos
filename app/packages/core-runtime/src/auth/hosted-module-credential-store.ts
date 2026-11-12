import { Deferred, Effect, Option, Ref } from 'effect';
import type { Redacted } from 'effect';

import { HostedModuleCredentialsSealedError } from './hosted-module-credentials-sealed-error.ts';
import type {
  HostedModuleCredentialAcceptance,
  HostedModuleCredentialCopy,
  HostedModuleCredentials,
} from './hosted-module-credentials.ts';
import { workloadEntryAppId } from './hosted-module-credentials.ts';

type Slot = Ref.Ref<Option.Option<Redacted.Redacted>>;

/**
 * One copy of the hosted module credentials, private to this module: no global handle reaches it, and no package
 * export reaches this file. An owner reaches only its own slot, through `@app/core-runtime/auth/owner-module-credential`,
 * which the delegated gateway client alone imports (`scripts/tests/module-credential-reader-boundary.test.mts`).
 *
 * A built owner bundle inlines its own copy of this module, so a process that serves several bundles holds several
 * copies. The host program claims each one: the unit's build exposes exactly its bundle's claim, the unit's generated
 * entry re-exports it, and the host claims that copy for the unit's own module right after loading the unit and before
 * it serves (`scripts/zerops/hosted-credential-claim.mts`, `scripts/zerops/serve-units.mts`). A copy nobody claimed
 * holds no key: its owner's delegated calls fail closed, and nothing is ever read from the environment. The isolation
 * between owners of one process is cooperative: see DEPLOYMENT.md, "Module credentials and bindings".
 */
interface HostedSlots {
  readonly owners: ReadonlyMap<string, Slot>;
  /** The owners' internal workload credentials, by `<app id>/<workload key>/<tenant id>`. */
  readonly workloads: Ref.Ref<ReadonlyMap<string, Redacted.Redacted>>;
}

const hostedClaim = Deferred.makeUnsafe<HostedSlots>();

/** The owner's own module credential in this copy: none when the host has not claimed it or handed no key over. */
export const hostedSlot = Effect.fn('HostedModuleCredentials.hostedSlot')(function* readHostedSlot(appId: string) {
  const claim = yield* Deferred.poll(hostedClaim);
  if (Option.isNone(claim)) {
    return Option.none<Redacted.Redacted>();
  }
  const slot = (yield* claim.value).owners.get(appId);
  return slot === undefined ? Option.none<Redacted.Redacted>() : yield* Ref.get(slot);
});

/**
 * Claims this copy for the `owners` it serves, before any of them serves. Each slot starts empty and only the returned
 * receiver, fed by the host's private channel, fills or replaces it; a handover naming another module is refused.
 * Claiming a copy twice is refused, so code that runs later cannot obtain a receiver.
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
      reason: 'These hosted module credentials are already claimed',
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
  return {
    accept,
    owners: [...slots.keys()],
    read: (appId: string) => hostedSlot(appId),
  } satisfies HostedModuleCredentialCopy;
});

/** An owner's internal workload credential in one tenant, if the host handed one over; none in an unclaimed copy. */
export const hostedWorkloadSlot = Effect.fn('HostedModuleCredentials.hostedWorkloadSlot')(function* readWorkloadSlot(
  entry: string,
) {
  const claim = yield* Deferred.poll(hostedClaim);
  if (Option.isNone(claim)) {
    return Option.none<Redacted.Redacted>();
  }
  return Option.fromUndefinedOr((yield* Ref.get((yield* claim.value).workloads)).get(entry));
});
