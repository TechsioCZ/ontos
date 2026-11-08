import { Result, Schema } from 'effect';

import type { AccessDeclarationInput } from '../../authorization/access-declaration.ts';
import { withOptional } from '../decision/optional.ts';
import { ModuleKeySchema } from '../ids.ts';
import type { CapabilityKey, ModuleKey } from '../ids.ts';
import type { CatalogSnapshotEntry } from '../model.ts';
import { ACCESS_MODEL_PARSE_OPTIONS, CatalogSnapshotEntrySchema } from '../model.ts';
import { compareText } from './compare.ts';
import type { AccessChangesError } from './errors.ts';
import { accessChangesError } from './errors.ts';

/**
 * What a module currently declares for one protected entrypoint. `published` is the module's own
 * release statement, never the declaration's classification: a correct declaration can exist for
 * an entrypoint the module has not published yet (O1).
 */
export interface PublishedDescriptorInput {
  readonly declaration: AccessDeclarationInput;
  readonly moduleId: string;
  /**
   * The containing declaration of a field group, so the released entry names the read its access
   * rides (D14, O58, O74/O87). Absent for every other declaration.
   */
  readonly parentKey?: string;
  readonly published: boolean;
}

export interface UnpublishedDescriptor {
  readonly capabilityKey: string;
  readonly moduleId: string;
}

export interface PublishedCatalog {
  /** The configurable catalog: published declarations only, in key order. */
  readonly entries: readonly CatalogSnapshotEntry[];
  /** Declared, correctly classified and deliberately withheld until the module publishes (O1). */
  readonly unpublished: readonly UnpublishedDescriptor[];
}

const decodeEntry = Schema.decodeUnknownResult(CatalogSnapshotEntrySchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeModuleKey = Schema.decodeUnknownResult(ModuleKeySchema);

/** A declaration owns keys of its own module only, so a catalog entry can never borrow a prefix. */
const ownsKey = (moduleId: string, key: string): boolean => {
  const segments = key.startsWith(`${moduleId}.`) ? key.slice(moduleId.length + 1).split('.') : [];
  return segments.length >= 2 && segments.every((segment) => segment.length > 0);
};

/**
 * The catalog-relevant shape of one declaration, before it is decoded into a snapshot entry. It is a
 * plain boundary contract so a hand-written or stale module descriptor is refused, not trusted.
 */
export interface CatalogEntryInput {
  readonly amountInput?: string;
  readonly ephemeral?: true;
  readonly fieldClass?: string;
  readonly key: string;
  readonly kind: string;
  readonly lineage?: { readonly renamedFrom?: readonly string[]; readonly splitFrom?: string };
  readonly modes: readonly string[];
  readonly moduleKey: string;
  readonly parentKey?: string;
  readonly placement: { readonly group: string; readonly level: string };
  readonly risk: string;
  readonly selectors: readonly string[];
}

/** The snapshot entry a published declaration contributes; only catalog-relevant fields survive. */
const projectEntry = (
  declaration: AccessDeclarationInput,
  moduleKey: ModuleKey,
  parentKey: string | undefined,
): CatalogEntryInput => {
  const base = {
    key: declaration.key,
    kind: declaration.kind,
    modes: declaration.modes,
    moduleKey,
    placement: declaration.placement,
    risk: declaration.risk,
    selectors: declaration.selectors,
  };
  const withEphemeral = declaration.ephemeral === true ? { ...base, ephemeral: true as const } : base;
  const withFieldClass =
    declaration.fieldClass === undefined ? withEphemeral : { ...withEphemeral, fieldClass: declaration.fieldClass };
  const withAmountInput =
    declaration.amountInput === undefined
      ? withFieldClass
      : { ...withFieldClass, amountInput: declaration.amountInput };
  const withLineage =
    declaration.lineage === undefined ? withAmountInput : { ...withAmountInput, lineage: declaration.lineage };
  // A field group carries the declaration its access rides; the snapshot schema refuses a parent on
  // anything else and a field group without one, so nothing here decides that rule twice (O87).
  return withOptional(withLineage, 'parentKey', parentKey);
};

/** One catalog entry, validated against the model's snapshot schema (O1, O5). */
export const decodeCatalogEntry = (input: CatalogEntryInput): Result.Result<CatalogSnapshotEntry, AccessChangesError> =>
  Result.mapError(decodeEntry(input), (issue) =>
    accessChangesError('access_changes_declaration_invalid', `${input.key}: ${issue.message}`),
  );

const decodePublishedEntry = (
  descriptor: PublishedDescriptorInput,
  moduleKey: ModuleKey,
): Result.Result<CatalogSnapshotEntry, AccessChangesError> =>
  decodeCatalogEntry(projectEntry(descriptor.declaration, moduleKey, descriptor.parentKey));

const unpublishedDescriptor = (descriptor: PublishedDescriptorInput): UnpublishedDescriptor =>
  Object.freeze({ capabilityKey: descriptor.declaration.key, moduleId: descriptor.moduleId });

/**
 * The publication gate (O1): only a published declaration reaches the configurable catalog, the
 * role editor, the catalog snapshot or Novinky. Withheld declarations are reported so the release
 * stays visible to its author, and they carry no capability, item or grant meanwhile.
 */
export const projectPublishedCatalog = (
  descriptors: readonly PublishedDescriptorInput[],
): Result.Result<PublishedCatalog, AccessChangesError> => {
  const entries: CatalogSnapshotEntry[] = [];
  const unpublished: UnpublishedDescriptor[] = [];
  const publishedKeys = new Set<string>();
  for (const descriptor of descriptors) {
    const moduleKey = decodeModuleKey(descriptor.moduleId);
    if (Result.isFailure(moduleKey)) {
      return Result.fail(
        accessChangesError('access_changes_foreign_module_key', `module id ${descriptor.moduleId} is not a module key`),
      );
    }
    if (!ownsKey(descriptor.moduleId, descriptor.declaration.key)) {
      return Result.fail(
        accessChangesError(
          'access_changes_foreign_module_key',
          `access key ${descriptor.declaration.key} does not belong to module ${descriptor.moduleId}`,
        ),
      );
    }
    if (!descriptor.published) {
      unpublished.push(unpublishedDescriptor(descriptor));
      continue;
    }
    const { key } = descriptor.declaration;
    if (publishedKeys.has(key)) {
      return Result.fail(
        accessChangesError('access_changes_duplicate_capability', `capability ${key} is published twice`),
      );
    }
    const entry = decodePublishedEntry(descriptor, moduleKey.success);
    if (Result.isFailure(entry)) {
      return Result.fail(entry.failure);
    }
    publishedKeys.add(key);
    entries.push(entry.success);
  }
  return Result.succeed(
    Object.freeze({
      entries: Object.freeze(entries.toSorted((left, right) => compareText(left.key, right.key))),
      unpublished: Object.freeze(
        unpublished.toSorted(
          (left, right) =>
            compareText(left.moduleId, right.moduleId) || compareText(left.capabilityKey, right.capabilityKey),
        ),
      ),
    }),
  );
};

/** The published capability set an adoption must find its item in (O1, guarantee 2). */
export const publishedCapabilityKeys = (entries: readonly CatalogSnapshotEntry[]): ReadonlySet<CapabilityKey> =>
  new Set(entries.map(({ key }) => key));
