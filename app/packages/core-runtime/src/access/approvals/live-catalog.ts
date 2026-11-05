import { Effect, Option } from 'effect';

import type { AccessChangesStoreService } from '../changes/persistence/store.ts';
import { withOptional } from '../decision/optional.ts';
import type { CapabilityKey, ModuleKey } from '../ids.ts';
import type { CatalogSnapshot, CatalogSnapshotEntry } from '../model.ts';
import { ApprovalStorageUnavailableError } from './errors.ts';
import type { GovernedCapability } from './policy.ts';
import type { ApprovalCapabilityCatalog } from './service.ts';

/*
 * The published release as the approvals rules read it (O1, P5). A proposal, a mandate and an
 * execution are all bound to facts the catalog published — the capability's kind, risk, modes and
 * selectors — so those facts come from `core.access_catalog_entries`, exactly as Novinky and the role
 * editor already read them, and never from a caller's claim about its own capability.
 *
 * The reader is the shipped Novinky one: `AccessChangesStore.loadPublishedCatalog` answers the newest
 * published release with the entries pinned to it, and this module adds no second view of that table.
 * A release is platform-wide, so the lookup takes no scope, and a capability key resolves to the
 * newest published entry that names it.
 */

const storageUnavailable = (reason: string) =>
  new ApprovalStorageUnavailableError({ code: 'approval_storage_unavailable', reason });

/**
 * One released entry as `ApprovalCapabilityCatalog` reads it. Every field is a published fact. A
 * release that names no governing parent read leaves that fact absent, and the policy that needs it
 * refuses a record-scoped approval instead of inventing one (D30).
 */
export const publishedCapabilityOf = (entry: CatalogSnapshotEntry): GovernedCapability =>
  withOptional(
    {
      capabilityKey: entry.key,
      kind: entry.kind,
      modes: entry.modes,
      risk: entry.risk,
      selectors: entry.selectors,
    },
    'ephemeral',
    entry.ephemeral,
  );

/** The published release the proposal and mandate rules read, with the module each key declares. */
export interface LivePublishedCatalog extends ApprovalCapabilityCatalog {
  /**
   * The module that declares this capability. A record-scoped decision asks the owner for its
   * projection of the record inside the module that owns it (H3, D32), so the module is a released
   * fact and never the request's.
   */
  readonly moduleKeyOf: (
    capabilityKey: CapabilityKey,
  ) => Effect.Effect<Option.Option<ModuleKey>, ApprovalStorageUnavailableError>;
}

/** The entries of one release, keyed by capability key. */
const entriesByKey = (release: CatalogSnapshot): ReadonlyMap<string, CatalogSnapshotEntry> => {
  const byKey = new Map<string, CatalogSnapshotEntry>();
  for (const entry of release.entries) {
    byKey.set(entry.key, entry);
  }
  return byKey;
};

/** One published release, keyed by capability, read once per question. */
const publishedEntries = (
  loadRelease: AccessChangesStoreService['loadPublishedCatalog'],
): Effect.Effect<Option.Option<ReadonlyMap<string, CatalogSnapshotEntry>>, ApprovalStorageUnavailableError> =>
  loadRelease().pipe(
    Effect.mapError((failure) => storageUnavailable(`${failure.code}: ${failure.reason}`)),
    Effect.map((snapshot) =>
      Option.match(snapshot, {
        onNone: () => Option.none<ReadonlyMap<string, CatalogSnapshotEntry>>(),
        onSome: (release) => Option.some(entriesByKey(release)),
      }),
    ),
  );

/** The entry of one key, or none while the release does not publish it. */
const entryOf = (
  loadRelease: AccessChangesStoreService['loadPublishedCatalog'],
  capabilityKey: CapabilityKey,
): Effect.Effect<Option.Option<CatalogSnapshotEntry>, ApprovalStorageUnavailableError> =>
  publishedEntries(loadRelease).pipe(
    Effect.map((entries) =>
      Option.match(entries, {
        onNone: () => Option.none<CatalogSnapshotEntry>(),
        onSome: (byKey) => Option.fromUndefinedOr(byKey.get(capabilityKey)),
      }),
    ),
  );

/**
 * The live catalog: one read of the published release per question, so a capability retired from the
 * release stops being proposable at the next question instead of at the next restart.
 */
export const livePublishedCatalog = (
  loadRelease: AccessChangesStoreService['loadPublishedCatalog'],
): LivePublishedCatalog => {
  const catalog: LivePublishedCatalog = {
    lookup: (capabilityKey: CapabilityKey) =>
      entryOf(loadRelease, capabilityKey).pipe(Effect.map(Option.map(publishedCapabilityOf))),
    moduleKeyOf: (capabilityKey: CapabilityKey) =>
      entryOf(loadRelease, capabilityKey).pipe(Effect.map(Option.map((entry) => entry.moduleKey))),
  };
  return Object.freeze(catalog);
};
