import { DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  AccessCatalogDescriptor,
  AccessCatalogModule,
  AccessDeclarationInput,
  AccessFieldGroupInput,
} from '../../src/authorization/access-declaration.ts';
import {
  buildAccessCatalogRelease,
  catalogReleaseDigest,
  catalogReleaseId,
  catalogReleaseLines,
} from '../../src/access/catalog/release.ts';
import { projectPublishedCatalog } from '../../src/access/changes/publication.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  CatalogSnapshotEntrySchema,
  CatalogSnapshotSchema,
} from '../../src/access/model.ts';
import type { CatalogSnapshotEntry } from '../../src/access/model.ts';
import type { AccessCatalogReleaseError } from '../../src/access/catalog/errors.ts';
import { CapabilityKeySchema, ModuleKeySchema } from '../../src/access/ids.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

/*
 * The release builder is the one place a declaration becomes configurable (O1, O67-Q7). It is pure, so this
 * suite holds it to its three promises: only the installed modules' declarations enter the release, the
 * release identity is its content, and a declaration Core would refuse never reaches a role editor.
 */
const publishedAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T09:00:00Z'));

const actionEntrypoint = (moduleKey: string, key: string) =>
  defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: key,
    moduleKey,
    role: 'action',
  });
const readEntrypoint = (moduleKey: string, key: string) =>
  defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: key,
    moduleKey,
    role: 'api',
  });

const declarationOf = (
  entrypoint: AccessCatalogDescriptor['entrypoint'],
  input: AccessDeclarationInput,
): AccessCatalogDescriptor => ({ accessDeclaration: input, entrypoint });

const readDeclaration = (key: string, overrides: Partial<AccessDeclarationInput> = {}): AccessDeclarationInput => ({
  key,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'invoices', level: 'basic' },
  risk: 'routine',
  selectors: [],
  ...overrides,
});

const voidDeclaration = (key: string, overrides: Partial<AccessDeclarationInput> = {}): AccessDeclarationInput => ({
  key,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'invoices', level: 'manage' },
  risk: 'critical',
  selectors: [],
  ...overrides,
});

const marginsGroup = (key: string): AccessFieldGroupInput => ({
  fieldClass: 'margins',
  fields: ['margins.gross'],
  key,
  kind: 'field_read',
  modes: ['run'],
  placement: { group: 'invoices', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
});

/** One module of the composition: the release only ever sees the declarations of an installed one. */
const moduleOf = (moduleKey: string, descriptors: readonly AccessCatalogDescriptor[]): AccessCatalogModule => ({
  descriptors,
  moduleId: moduleKey,
});

const listDescriptor = declarationOf(
  readEntrypoint('billing.invoices', 'billing.invoices.invoice.list'),
  readDeclaration('billing.invoices.invoice.list'),
);
const voidDescriptor = declarationOf(
  actionEntrypoint('billing.invoices', 'billing.invoices.invoice.void'),
  voidDeclaration('billing.invoices.invoice.void'),
);
const detailDescriptor: AccessCatalogDescriptor = {
  accessDeclaration: readDeclaration('billing.invoices.invoice.detail'),
  accessFieldGroups: [marginsGroup('billing.invoices.invoice.detail.margins')],
  entrypoint: readEntrypoint('billing.invoices', 'billing.invoices.invoice.detail'),
};
const invoicesModule = moduleOf('billing.invoices', [listDescriptor, voidDescriptor, detailDescriptor]);
const partiesModule = moduleOf('party.registry', [
  declarationOf(
    readEntrypoint('party.registry', 'party.registry.party.list'),
    readDeclaration('party.registry.party.list'),
  ),
]);

const releaseOf = (input: {
  readonly installedModuleKeys: readonly string[];
  readonly modules: readonly AccessCatalogModule[];
}) =>
  buildAccessCatalogRelease({
    installedModuleKeys: input.installedModuleKeys.map((moduleKey) => ModuleKeySchema.make(moduleKey)),
    modules: input.modules,
    publishedAt,
  });

/** One declaration through the publication gate alone, so the entry rules are proven on their own. */
const publishedEntryOf = (declaration: AccessDeclarationInput) =>
  Result.getOrThrow(projectPublishedCatalog([{ declaration, moduleId: 'billing.invoices', published: true }]));

const refusalOf = (input: {
  readonly installedModuleKeys: readonly string[];
  readonly modules: readonly AccessCatalogModule[];
}): AccessCatalogReleaseError | undefined => {
  const built = releaseOf(input);
  return Result.isFailure(built) ? built.failure : undefined;
};

it.effect('publishes every declaration of the installed modules and nothing of the others', () =>
  Effect.sync(() => {
    const release = Result.getOrThrow(
      releaseOf({ installedModuleKeys: ['billing.invoices'], modules: [invoicesModule, partiesModule] }),
    );
    // The two declarations and the field group of the installed module: a group is its own entry (O58).
    expect(release.entries.map(({ key }) => key)).toEqual([
      'billing.invoices.invoice.detail',
      'billing.invoices.invoice.detail.margins',
      'billing.invoices.invoice.list',
      'billing.invoices.invoice.void',
    ]);
    expect(release.publishedAt).toEqual(publishedAt);
    // A module the tenant does not have is not published at all (O7, O67-Q7).
    expect(release.entries.some(({ key }) => key.startsWith('party.registry.'))).toBe(false);
    expect(release.entries.find(({ key }) => key === 'billing.invoices.invoice.void')?.risk).toBe('critical');
    expect(release.entries.find(({ key }) => key === 'billing.invoices.invoice.void')?.modes).toEqual([
      'run',
      'propose',
      'approve',
    ]);
    expect(release.entries.find(({ key }) => key === 'billing.invoices.invoice.detail.margins')?.fieldClass).toBe(
      'margins',
    );
  }),
);

it.effect('makes the release identity its content, so an unchanged catalog is the same release', () =>
  Effect.sync(() => {
    const first = Result.getOrThrow(
      releaseOf({ installedModuleKeys: ['billing.invoices'], modules: [invoicesModule, partiesModule] }),
    );
    // Declaration order inside a module and the order of the modules themselves are not content.
    const reordered = Result.getOrThrow(
      releaseOf({
        installedModuleKeys: ['billing.invoices'],
        modules: [moduleOf('billing.invoices', [detailDescriptor, listDescriptor, voidDescriptor]), partiesModule],
      }),
    );
    expect(reordered.digest).toBe(first.digest);
    expect(reordered.id).toBe(first.id);
    expect(catalogReleaseLines(reordered.entries)).toEqual(catalogReleaseLines(first.entries));

    // A wider risk, another selector, another mode and a rename are all content.
    const reRisked = Result.getOrThrow(
      releaseOf({
        installedModuleKeys: ['billing.invoices'],
        modules: [
          moduleOf('billing.invoices', [
            declarationOf(
              readEntrypoint('billing.invoices', 'billing.invoices.invoice.list'),
              readDeclaration('billing.invoices.invoice.list', { risk: 'sensitive' }),
            ),
            voidDescriptor,
            detailDescriptor,
          ]),
        ],
      }),
    );
    expect(reRisked.digest).not.toBe(first.digest);
    expect(reRisked.id).not.toBe(first.id);
    expect(catalogReleaseDigest(reRisked.entries)).toBe(reRisked.digest);
  }),
);

it.effect('refuses a release the declarations cannot form, and names the module that refused it', () =>
  Effect.sync(() => {
    // A field group without its own declaration is not a catalog entry (O58).
    const groupWithoutParent = refusalOf({
      installedModuleKeys: ['billing.invoices'],
      modules: [
        moduleOf('billing.invoices', [
          {
            accessFieldGroups: [marginsGroup('billing.invoices.invoice.orphan.margins')],
            entrypoint: readEntrypoint('billing.invoices', 'billing.invoices.invoice.orphan'),
          },
        ]),
      ],
    });
    expect(groupWithoutParent?.code).toBe('access_catalog_release_declarations_refused');
    expect(groupWithoutParent?.reason).toContain('billing.invoices');

    // A capability key that borrows another module's prefix is refused, never published under it (O27).
    const foreignKey = refusalOf({
      installedModuleKeys: ['billing.invoices'],
      modules: [
        moduleOf('billing.invoices', [
          declarationOf(
            readEntrypoint('billing.invoices', 'billing.invoices.invoice.foreign'),
            readDeclaration('party.registry.party.list'),
          ),
        ]),
      ],
    });
    expect(foreignKey?.code).toBe('access_catalog_release_declarations_refused');

    // A classification the declaration contract refuses is a definition error here too (O5).
    const suspiciousModes = refusalOf({
      installedModuleKeys: ['billing.invoices'],
      modules: [
        moduleOf('billing.invoices', [
          declarationOf(
            actionEntrypoint('billing.invoices', 'billing.invoices.invoice.stamp'),
            voidDeclaration('billing.invoices.invoice.stamp', { modes: ['approve'] }),
          ),
        ]),
      ],
    });
    expect(suspiciousModes?.code).toBe('access_catalog_release_declarations_refused');
  }),
);

it.effect('keeps a broken declaration of an uninstalled module out of the release entirely', () =>
  Effect.sync(() => {
    // The release is published while a neighbour module is still half-written: it must not fail the
    // tenant whose modules are all valid, and the broken module must not appear (O1).
    const brokenNeighbour = moduleOf('party.registry', [
      declarationOf(
        readEntrypoint('party.registry', 'party.registry.party.list'),
        readDeclaration('billing.invoices.invoice.list'),
      ),
    ]);
    const release = Result.getOrThrow(
      releaseOf({ installedModuleKeys: ['billing.invoices'], modules: [invoicesModule, brokenNeighbour] }),
    );
    expect(release.entries.every(({ moduleKey }) => moduleKey === 'billing.invoices')).toBe(true);
    // The same module, installed, is refused instead of being published under a key it does not own.
    expect(
      refusalOf({
        installedModuleKeys: ['billing.invoices', 'party.registry'],
        modules: [invoicesModule, brokenNeighbour],
      })?.code,
    ).toBe('access_catalog_release_declarations_refused');
  }),
);

it.effect('names the parent capability of every field group the release publishes (O87)', () =>
  Effect.gen(function* namesFieldGroupParents() {
    const release = Result.getOrThrow(
      releaseOf({ installedModuleKeys: ['billing.invoices'], modules: [invoicesModule] }),
    );
    const group = release.entries.find(({ key }) => key === 'billing.invoices.invoice.detail.margins');
    expect(group).toBeDefined();
    if (group === undefined) {
      return;
    }
    // The group names the read its access rides, so "Proč?" and Novinky decide the parent read from the
    // released catalog itself and never from a caller (O74, O87).
    expect(group?.parentKey).toBe('billing.invoices.invoice.detail');
    // Nothing else names a parent: a capability that is not a field group declares none.
    expect(release.entries.filter(({ parentKey }) => parentKey !== undefined).map(({ key }) => key)).toEqual([
      'billing.invoices.invoice.detail.margins',
    ]);
    // The parent of the release is itself an entry of the same release, so the answer is always local.
    expect(release.entries.some(({ key }) => key === group?.parentKey)).toBe(true);

    // Negative control: a field group published without its parent is refused, not silently orphaned.
    const orphan = projectPublishedCatalog([
      {
        declaration: marginsGroup('billing.invoices.invoice.detail.margins'),
        moduleId: 'billing.invoices',
        published: true,
      },
    ]);
    expect(Result.isFailure(orphan)).toBe(true);
    // And a capability that is not a field group may not name a parent at all.
    const foreignParent = projectPublishedCatalog([
      {
        declaration: readDeclaration('billing.invoices.invoice.list'),
        moduleId: 'billing.invoices',
        parentKey: 'billing.invoices.invoice.detail',
        published: true,
      },
    ]);
    expect(Result.isFailure(foreignParent)).toBe(true);

    // The parent survives the encode the catalog store persists (`entry_json`), so a released snapshot
    // read back from the database still answers the parent read itself (O87).
    const storedEntry = Schema.fromJsonString(CatalogSnapshotEntrySchema);
    const persisted = yield* Schema.encodeEffect(storedEntry)(group);
    const reloaded = yield* Schema.decodeEffect(storedEntry)(persisted);
    expect(reloaded.parentKey).toBe('billing.invoices.invoice.detail');

    // The parent is part of the release identity: the same entry with another parent is another release.
    const [line] = catalogReleaseLines([group]);
    const reparented: CatalogSnapshotEntry = {
      ...group,
      parentKey: CapabilityKeySchema.make('billing.invoices.invoice.list'),
    };
    expect(catalogReleaseLines([reparented])).not.toEqual([line]);

    // A snapshot whose field group names a parent the release does not contain is refused: a broken
    // catalog must never reach a decision (the caller answers 503, never a denial, on such a defect).
    const entries = [reparented];
    const digest = catalogReleaseDigest(entries);
    const snapshot = Schema.decodeResult(
      CatalogSnapshotSchema,
      ACCESS_MODEL_PARSE_OPTIONS,
    )({
      digest,
      entries,
      id: catalogReleaseId(digest),
      publishedAt,
    });
    expect(Result.isFailure(snapshot)).toBe(true);
  }),
);

it.effect('carries an ephemeral proof so a consumer never re-derives a policy input (O22, O87)', () =>
  Effect.sync(() => {
    const commit = 'billing.invoices.invoice.commit';
    const proofDeclaration: AccessDeclarationInput = {
      ...voidDeclaration(commit),
      ephemeral: true,
      modes: ['run'],
      risk: 'sensitive',
    };
    const withProof = publishedEntryOf(proofDeclaration);
    const [entry] = withProof.entries;
    expect(entry?.ephemeral).toBe(true);
    expect(entry?.modes).toEqual(['run']);
    // The proof is part of the release identity, so a capability that becomes ephemeral is a new release.
    const { ephemeral: _ephemeral, ...withoutProofDeclaration } = proofDeclaration;
    const withoutProof = publishedEntryOf(withoutProofDeclaration);
    expect(catalogReleaseLines(withProof.entries)).not.toEqual(catalogReleaseLines(withoutProof.entries));

    // Negative control: only an Action may be ephemeral, and an ephemeral proof is run-only (O22).
    expect(
      Result.isFailure(
        projectPublishedCatalog([
          {
            declaration: { ...readDeclaration('billing.invoices.invoice.list'), ephemeral: true },
            moduleId: 'billing.invoices',
            published: true,
          },
        ]),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        projectPublishedCatalog([
          {
            declaration: { ...voidDeclaration('billing.invoices.invoice.void'), ephemeral: true },
            moduleId: 'billing.invoices',
            published: true,
          },
        ]),
      ),
    ).toBe(true);
  }),
);
