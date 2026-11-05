import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import type { AccessCatalogModule } from '../../authorization/access-declaration.ts';
import { releaseRefusal } from './errors.ts';
import type { AccessCatalogReleaseError } from './errors.ts';
import { collectAccessCatalog } from '../../authorization/access-declaration.ts';
import { projectPublishedCatalog } from '../changes/publication.ts';
import type { PublishedDescriptorInput } from '../changes/publication.ts';
import type { CatalogDigest, CatalogSnapshotId, ModuleKey } from '../ids.ts';
import { CatalogDigestSchema, CatalogSnapshotIdSchema, ModuleKeySchema } from '../ids.ts';
import type { CatalogSnapshot, CatalogSnapshotEntry } from '../model.ts';
import { ACCESS_MODEL_PARSE_OPTIONS, CatalogSnapshotSchema } from '../model.ts';
import { stableUuid } from './stable-id.ts';

/*
 * The one builder of a release catalog (O1, O67-Q7). PostgreSQL holds the release and every role
 * revision pins it, so the builder is pure: declarations of the modules a tenant has installed go in,
 * the immutable snapshot that role cells are validated against comes out.
 *
 * Publication is decided here, once: the initial release publishes every declaration of the installed
 * modules (O67-Q7), because nothing has been configured yet. A declaration the module has not
 * published stays a correct declaration and simply is not in the release (O1) — after the initial
 * release, later capabilities arrive through Novinky and an explicit adoption, never by rebuilding
 * the snapshot a role was already pinned to.
 *
 * The identity of a release is its content: entry order, digest and identifier all derive from the
 * snapshot entries, so building the same declarations twice yields the same release instead of a
 * second one, and a retried publication writes nothing (D3).
 */

export interface BuildAccessCatalogReleaseInput {
  /** The tenant's module installations; a module that is not installed contributes no declaration. */
  readonly installedModuleKeys: readonly ModuleKey[];
  /** Every module the running composition declares, installed or not. */
  readonly modules: readonly AccessCatalogModule[];
  /** The instant the release is published at; Core mints it, the builder never reads a clock. */
  readonly publishedAt: Date;
}

const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** The separator is outside every vocabulary of the release, so no field can forge a line. */
const FIELD_SEPARATOR = '\u001F';
const LINE_SEPARATOR = '\n';

/**
 * One entry as exactly the fields the model stores, in a fixed order. Lineage is part of a release
 * (D11), so a rename or a split changes the digest and therefore the release identity.
 */
const entryLine = (entry: CatalogSnapshotEntry): string =>
  [
    entry.key,
    entry.kind,
    entry.moduleKey,
    entry.risk,
    entry.placement.group,
    entry.placement.level,
    entry.modes.join(','),
    entry.selectors.join(','),
    entry.ephemeral === true ? 'ephemeral' : '',
    entry.fieldClass ?? '',
    entry.amountInput ?? '',
    entry.parentKey ?? '',
    [...(entry.lineage?.renamedFrom ?? [])].toSorted(compareText).join(','),
    entry.lineage?.splitFrom ?? '',
  ].join(FIELD_SEPARATOR);

/** The canonical text of a release: what its digest is computed over, and nothing else. */
export const catalogReleaseLines = (entries: readonly CatalogSnapshotEntry[]): readonly string[] =>
  [...entries].toSorted((left, right) => compareText(left.key, right.key)).map(entryLine);

/** The release identity: SHA-256 over the canonical text of its entries. */
export const catalogReleaseDigest = (entries: readonly CatalogSnapshotEntry[]): CatalogDigest =>
  CatalogDigestSchema.make(Hex.encode(sha256(utf8ToBytes(catalogReleaseLines(entries).join(LINE_SEPARATOR)))));

/**
 * The release identifier is its digest, so the same content is the same release. A retried
 * publication then resolves to the row that already exists instead of failing as a second release.
 */
export const catalogReleaseId = (digest: CatalogDigest): CatalogSnapshotId =>
  CatalogSnapshotIdSchema.make(stableUuid(`ontos.access.catalog-release:${digest}`));

const decodeModuleKey = Schema.decodeUnknownResult(ModuleKeySchema);

/** The installed module keys, decoded, so a nameless installation can never be filtered by text. */
const installedModuleKeysOf = (
  input: BuildAccessCatalogReleaseInput,
): Result.Result<ReadonlySet<string>, AccessCatalogReleaseError> => {
  const keys = new Set<string>();
  for (const installed of input.installedModuleKeys) {
    const decoded = decodeModuleKey(installed);
    if (Result.isFailure(decoded)) {
      return Result.fail(
        releaseRefusal(
          'access_catalog_release_declarations_refused',
          `${installed} is not a module key: ${decoded.failure.message}`,
        ),
      );
    }
    keys.add(decoded.success);
  }
  return Result.succeed(keys);
};

/** The declarations of the installed modules, as the publication gate reads them (O1, O67-Q7). */
const publishedInputs = (
  input: BuildAccessCatalogReleaseInput,
  installed: ReadonlySet<string>,
): readonly PublishedDescriptorInput[] => {
  const descriptors: PublishedDescriptorInput[] = [];
  for (const module of input.modules) {
    if (!installed.has(module.moduleId)) {
      continue;
    }
    for (const descriptor of module.descriptors) {
      const { accessDeclaration } = descriptor;
      if (accessDeclaration === undefined) {
        // Field groups require the descriptor's own declaration (O58), so a carrier without one
        // contributes nothing at all and is refused at definition time elsewhere.
        continue;
      }
      // O67-Q7: the initial release publishes every declaration of an installed module.
      descriptors.push({ declaration: accessDeclaration, moduleId: module.moduleId, published: true });
      for (const group of descriptor.accessFieldGroups ?? []) {
        // A field group is its own catalog entry and follows its descriptor's publication (O58); it
        // names the declaration its access rides, so the release answers the parent read itself (O87).
        descriptors.push({
          declaration: group,
          moduleId: module.moduleId,
          parentKey: accessDeclaration.key,
          published: true,
        });
      }
    }
  }
  return descriptors;
};

/**
 * Builds the release of the installed modules' declarations. Collection validates the declarations
 * themselves (key ownership, module identity, lineage), the publication gate validates the catalog
 * entries, and the model validates the snapshot they form. Nothing is published until all three
 * accept it, so a broken declaration can never reach a role editor or a role revision.
 */
export const buildAccessCatalogRelease = (
  input: BuildAccessCatalogReleaseInput,
): Result.Result<CatalogSnapshot, AccessCatalogReleaseError> => {
  const installed = installedModuleKeysOf(input);
  if (Result.isFailure(installed)) {
    return Result.fail(installed.failure);
  }
  const installedModules = input.modules.filter((module) => installed.success.has(module.moduleId));
  // A module that is not installed cannot break the release: its declarations are not published yet.
  const collected = collectAccessCatalog(installedModules);
  if (Result.isFailure(collected)) {
    return Result.fail(
      releaseRefusal(
        'access_catalog_release_declarations_refused',
        `${collected.failure.moduleId}: ${collected.failure.reason}`,
      ),
    );
  }
  const published = projectPublishedCatalog(publishedInputs(input, installed.success));
  if (Result.isFailure(published)) {
    return Result.fail(
      releaseRefusal(
        'access_catalog_release_declarations_refused',
        `${published.failure.code}: ${published.failure.reason}`,
      ),
    );
  }
  const { entries } = published.success;
  const digest = catalogReleaseDigest(entries);
  const snapshot = Schema.decodeResult(
    CatalogSnapshotSchema,
    ACCESS_MODEL_PARSE_OPTIONS,
  )({
    digest,
    entries,
    id: catalogReleaseId(digest),
    publishedAt: input.publishedAt,
  });
  return Result.isSuccess(snapshot)
    ? Result.succeed(snapshot.success)
    : Result.fail(
        releaseRefusal(
          'access_catalog_release_snapshot_refused',
          `the release entries are not a snapshot: ${snapshot.failure.message}`,
        ),
      );
};
