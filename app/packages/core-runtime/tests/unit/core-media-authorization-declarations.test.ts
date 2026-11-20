import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  collectAccessCatalog,
  decodeAccessDeclarationOrThrow,
  missingAccessCarrierIssue,
} from '../../src/authorization/access-declaration.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import {
  assetCurrentRead,
  assetDownloadRead,
  assetMetadataRead,
  confirmAssetAction,
  coreActionCatalog,
  recordAssetIntegrityFailureAction,
  renameDisplayFilenameAction,
  uploadAssetAction,
} from '../../src/index.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { MediaAssetRefSchema } from '../../src/resources/media-asset.ts';

/*
 * The authorization audit of every Core Media capability that exists (lane d20-08). The matrix lives in one place
 * so a reader sees the whole picture and a new declaration cannot slip in beside it: separate keys, the kind, risk
 * tier, placement and selectors ADR-0030 asks for, an exact record target on exactly the record-scoped ones, and
 * the dual carrier only where machines ingest. A declaration here only creates a catalog entry; it grants nobody
 * anything, which the SpiceDB-backed matrix proves.
 */

const mediaAssetId = '00000000-0000-4000-8000-0000000000a1';
const tenantId = '00000000-0000-4000-8000-0000000000a2';

const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-0000000000a3',
    authContextRef: 'core-media-audit',
    authMethod: 'session',
    principalId: '00000000-0000-4000-8000-0000000000a4',
    tenantId,
  }),
  correlationId: 'core-media-audit',
};
const mediaAssetRef = Schema.decodeUnknownSync(MediaAssetRefSchema)({
  moduleId: 'core.media',
  resourceId: mediaAssetId,
  resourceType: 'core.media.asset',
  tenantId,
});

const upload = uploadAssetAction.descriptor;
const confirm = confirmAssetAction.descriptor;
const rename = renameDisplayFilenameAction.descriptor;
const integrity = recordAssetIntegrityFailureAction.descriptor;
const metadata = assetMetadataRead.descriptor;
const download = assetDownloadRead.descriptor;
const current = assetCurrentRead.descriptor;
const ACTIONS = [upload, confirm, rename, integrity] as const;
const ALL = [upload, confirm, rename, integrity, metadata, download, current] as const;

/** The declarations of the seven capabilities that exist, as ADR-0030 and the design (D-H, A09, A11) fix them. */
const EXPECTED = {
  confirm: {
    key: 'core.media.asset.confirm',
    kind: 'action',
    modes: ['run'],
    placement: { group: 'media', level: 'extended' },
    risk: 'routine',
    selectors: [],
  },
  // The bytes of a file leave Core: the one sensitive capability, a read that agents never run on their own.
  // Current V1 for Catalog (#1443): one tenant-wide capability for the whole set, so a denial is the whole call's and
  // a filtered-out asset can never look absent. It grants neither metadata nor bytes.
  current: {
    key: 'core.media.asset-current.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'media', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  download: {
    key: 'core.media.asset-download.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'media', level: 'extended' },
    risk: 'sensitive',
    selectors: ['all'],
  },
  integrity: {
    key: 'core.media.asset-integrity.fail',
    kind: 'action',
    modes: ['run'],
    placement: { group: 'media', level: 'extended' },
    risk: 'routine',
    selectors: [],
  },
  metadata: {
    key: 'core.media.asset-metadata.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'media', level: 'basic' },
    risk: 'routine',
    selectors: ['all'],
  },
  rename: {
    key: 'core.media.display-filename.rename',
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    placement: { group: 'media', level: 'extended' },
    risk: 'routine',
    selectors: ['all'],
  },
  upload: {
    key: 'core.media.asset.upload',
    kind: 'action',
    modes: ['run'],
    placement: { group: 'media', level: 'extended' },
    risk: 'routine',
    selectors: [],
  },
} as const satisfies Record<string, AccessDeclarationInput>;

/**
 * Capabilities the design names whose operation does not exist yet. They are OPEN, not forgotten: each lane that
 * adds the operation must add the declaration with it, and update this list and the matrix in the same change.
 * The source scan below refuses a key here, or any other Core Media key, being declared anywhere in `src/` today,
 * so a half-added capability fails loudly.
 */
const OPEN_DECLARATIONS = ['core.media.operation.read'] as const;

it('declares each existing capability under its own key with the audited kind, risk, placement and selectors', () => {
  expect(upload.accessDeclaration).toEqual(EXPECTED.upload);
  expect(confirm.accessDeclaration).toEqual(EXPECTED.confirm);
  expect(rename.accessDeclaration).toEqual(EXPECTED.rename);
  expect(integrity.accessDeclaration).toEqual(EXPECTED.integrity);
  expect(metadata.accessDeclaration).toEqual(EXPECTED.metadata);
  expect(download.accessDeclaration).toEqual(EXPECTED.download);
  expect(current.accessDeclaration).toEqual(EXPECTED.current);
});

it('gives the seven capabilities seven distinct keys, all prefixed by the Core Media owner and none shared', () => {
  const keys = ALL.map((descriptor) => descriptor.accessDeclaration?.key ?? '');
  expect(new Set(keys).size).toBe(7);
  for (const key of keys) {
    expect(key.startsWith('core.media.')).toBe(true);
  }
  // No field group, lineage, ephemeral flag or money limit stands in for another capability.
  for (const descriptor of ALL) {
    expect(descriptor.accessDeclaration).not.toHaveProperty('lineage');
    expect(descriptor.accessDeclaration).not.toHaveProperty('ephemeral');
    expect(descriptor.accessDeclaration).not.toHaveProperty('amountInput');
    expect(descriptor.accessDeclaration).not.toHaveProperty('fieldClass');
    expect(descriptor.accessFieldGroups ?? []).toEqual([]);
  }
});

it('is protected and Core-owned on every entrypoint, so the one gate always asks', () => {
  for (const descriptor of ALL) {
    expect(descriptor.entrypoint).toMatchObject({
      authorization: { kind: 'protected' },
      moduleKey: 'core.media',
      scope: 'system',
    });
    expect(descriptor.owningModuleKey).toBe('core.media');
    expect(descriptor.legalEntityScope).toBe('optional');
    expect(descriptor.accessDeclaration).toBeDefined();
  }
  for (const descriptor of ACTIONS) {
    expect(descriptor.entrypoint).toMatchObject({ access: 'write', role: 'action' });
  }
  expect(metadata.entrypoint).toMatchObject({ access: 'read', role: 'api' });
  expect(download.entrypoint).toMatchObject({ access: 'read', role: 'api' });
  expect(current.entrypoint).toMatchObject({ access: 'read', role: 'api' });
});

it('is routine on every capability but the download, and only the rename may be proposed or approved', () => {
  // The integrity record is run-only too: a proposal keeps no proof, and a proof is a service, never a payload.
  expect(integrity.accessDeclaration?.modes).toEqual(['run']);
  for (const [name, declaration] of Object.entries(EXPECTED)) {
    // Bytes leaving Core are never routine: the download is sensitive, so an agent is refused it (design-part-2, D-H).
    expect(declaration.risk).toBe(name === 'download' ? 'sensitive' : 'routine');
  }
  expect(download.accessDeclaration?.risk).not.toBe('routine');
  expect(download.accessDeclaration?.modes).toEqual(['run']);
  // An upload leg is a run-only streaming operation: a parked proposal would keep no request body to stream.
  expect(upload.accessDeclaration?.modes).toEqual(['run']);
  expect(confirm.accessDeclaration?.modes).toEqual(['run']);
  expect(metadata.accessDeclaration?.modes).toEqual(['run']);
  expect(current.accessDeclaration?.modes).toEqual(['run']);
  expect(rename.accessDeclaration?.modes).toEqual(['run', 'propose', 'approve']);
});

it('names the one exact record on exactly the record-scoped capabilities, never a name, key or storage location', () => {
  // The reserve leg names no record (the asset does not exist yet) and confirm acts on the reservation: both are scope-wide.
  expect(upload.accessTarget).toBeUndefined();
  expect(confirm.accessTarget).toBeUndefined();
  // Current answers a whole set under one tenant-wide capability: no record selector, no record target.
  expect(current.accessTarget).toBeUndefined();
  expect(current.accessDeclaration?.selectors).toEqual([]);
  expect(upload.accessDeclaration?.selectors).toEqual([]);
  expect(confirm.accessDeclaration?.selectors).toEqual([]);
  // Record-scoped: the target is the asset id; the tenant half comes from the trusted scope.
  expect(metadata.accessTarget?.({ mediaAssetRef }, scope)).toEqual({
    moduleKey: 'core.media',
    recordKey: mediaAssetId,
  });
  expect(download.accessTarget?.({ mediaAssetRef }, scope)).toEqual({
    moduleKey: 'core.media',
    recordKey: mediaAssetId,
  });
  expect(download.accessDeclaration?.selectors).toEqual(['all']);
  const renamePayload = {
    displayFilename: Schema.decodeUnknownSync(rename.payloadSchema.fields.displayFilename)('new.pdf'),
    mediaAssetRef,
  };
  expect(rename.accessTarget?.(renamePayload, scope)).toEqual({ moduleKey: 'core.media', recordKey: mediaAssetId });
  expect(metadata.accessDeclaration?.selectors).toEqual(['all']);
  expect(rename.accessDeclaration?.selectors).toEqual(['all']);
});

it('rides the machine carrier on the upload legs and the integrity record only, with Core Media workload keys', () => {
  expect(upload.accessWorkload?.workloads).toEqual(['core.media.ingest']);
  expect(confirm.accessWorkload?.workloads).toEqual(['core.media.ingest']);
  // Recording proven corruption is its own workload: the ingest binding of an uploader never records integrity.
  expect(integrity.accessWorkload?.workloads).toEqual(['core.media.integrity']);
  expect(integrity.accessTarget).toBeUndefined();
  // Rename and the metadata read are human and agent only: a bound machine is refused by the declaration carrier.
  expect(rename.accessWorkload).toBeUndefined();
  expect(metadata.accessWorkload).toBeUndefined();
  // The download is human only too: a bound machine never downloads, and an agent is refused (sensitive read).
  expect(download.accessWorkload).toBeUndefined();
  // Current is a Catalog read decided as the requester: no machine carrier.
  expect(current.accessWorkload).toBeUndefined();
});

it('lists exactly the seven existing keys in the access catalog, with no duplicate and no workload entry', () => {
  const descriptors = ALL.flatMap((descriptor) =>
    descriptor.accessDeclaration === undefined
      ? []
      : [{ accessDeclaration: descriptor.accessDeclaration, entrypoint: descriptor.entrypoint }],
  );
  const catalog = Result.getOrThrow(collectAccessCatalog([{ descriptors, moduleId: 'core.media' }]));
  const keys = catalog.entries.map(({ accessDeclaration }) => accessDeclaration.key);
  expect(keys.toSorted()).toEqual([
    'core.media.asset-current.read',
    'core.media.asset-download.read',
    'core.media.asset-integrity.fail',
    'core.media.asset-metadata.read',
    'core.media.asset.confirm',
    'core.media.asset.upload',
    'core.media.display-filename.rename',
  ]);
});

it('has no Core Media Action beyond the audited ones', () => {
  const mediaActions = coreActionCatalog.filter(({ owningModuleKey }) => owningModuleKey === 'core.media');
  expect(mediaActions.map(({ actionKey }) => actionKey).toSorted()).toEqual([
    'core.media.confirm-asset',
    'core.media.record-asset-integrity-failure',
    'core.media.rename-display-filename',
    'core.media.upload-asset',
  ]);
});

it('makes a missing declaration on any Core Media entrypoint a definition-time error, never a reported gap', () => {
  for (const descriptor of ALL) {
    // The same entrypoint with no carrier at all is refused by the descriptor rules before it can be registered.
    expect(missingAccessCarrierIssue({ entrypoint: descriptor.entrypoint })).toBeDefined();
    expect(
      missingAccessCarrierIssue(
        descriptor.accessDeclaration === undefined
          ? { entrypoint: descriptor.entrypoint }
          : {
              accessDeclaration: decodeAccessDeclarationOrThrow(descriptor.accessDeclaration, descriptor.entrypoint),
              entrypoint: descriptor.entrypoint,
            },
      ),
    ).toBeUndefined();
  }
});

/** Every `.ts` source of the package, so a Core Media key declared anywhere is seen, not only in the four files. */
const allSources = Effect.fn('CoreMediaAuthorizationAudit.sources')(function* allSources() {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  const root = yield* path.fromFileUrl(new URL('../../src/', import.meta.url));
  const names = yield* fileSystem.readDirectory(root, { recursive: true });
  return yield* Effect.forEach(
    names.filter((name) => name.endsWith('.ts')),
    (name) => fileSystem.readFileString(path.join(root, name)).pipe(Effect.map((text) => [name, text] as const)),
    { concurrency: 16 },
  );
});

it.layer(NodeServices.layer, { excludeTestServices: true })('core media declarations in the source tree', (suite) => {
  suite.effect('are exactly the seven audited keys, and none of the still-open keys exists before its operation', () =>
    Effect.gen(function* sourceKeys() {
      const declared = new Set<string>();
      for (const [, text] of yield* allSources()) {
        for (const match of text.matchAll(/key:\s*'(?<key>core\.media\.[^']+)',\s*kind:/gu)) {
          declared.add(match.groups?.['key'] ?? '');
        }
      }
      expect([...declared].toSorted()).toEqual([
        'core.media.asset-current.read',
        'core.media.asset-download.read',
        'core.media.asset-integrity.fail',
        'core.media.asset-metadata.read',
        'core.media.asset.confirm',
        'core.media.asset.upload',
        'core.media.display-filename.rename',
      ]);
      for (const open of OPEN_DECLARATIONS) {
        expect(declared.has(open), `${open} is declared before its operation exists`).toBe(false);
      }
    }),
  );
});
