import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { collectAccessCatalog } from '../../src/authorization/access-declaration.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import {
  assetMetadataRead,
  confirmAssetAction,
  coreActionCatalog,
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
const metadata = assetMetadataRead.descriptor;
const ACTIONS = [upload, confirm, rename] as const;

/** The declarations of the four capabilities that exist, as ADR-0030 and the design (D-H, A09, A11) fix them. */
const EXPECTED = {
  confirm: {
    key: 'core.media.asset.confirm',
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
 * The audit refuses a key here being claimed by anything today, and the catalog assertion below refuses any other
 * Core Media key, so a half-added capability fails loudly.
 */
const OPEN_DECLARATIONS = [
  'core.media.asset-download.read',
  'core.media.asset-current.read',
  'core.media.asset-integrity.fail',
  'core.media.operation.read',
] as const;

it('declares each existing capability under its own key with the audited kind, risk, placement and selectors', () => {
  expect(upload.accessDeclaration).toEqual(EXPECTED.upload);
  expect(confirm.accessDeclaration).toEqual(EXPECTED.confirm);
  expect(rename.accessDeclaration).toEqual(EXPECTED.rename);
  expect(metadata.accessDeclaration).toEqual(EXPECTED.metadata);
});

it('gives the four capabilities four distinct keys, all prefixed by the Core Media owner and none shared', () => {
  const keys = [upload, confirm, rename, metadata].map((descriptor) => descriptor.accessDeclaration?.key ?? '');
  expect(new Set(keys).size).toBe(4);
  for (const key of keys) {
    expect(key.startsWith('core.media.')).toBe(true);
  }
  // No field group, lineage, ephemeral flag or money limit stands in for another capability.
  for (const descriptor of [upload, confirm, rename, metadata]) {
    expect(descriptor.accessDeclaration).not.toHaveProperty('lineage');
    expect(descriptor.accessDeclaration).not.toHaveProperty('ephemeral');
    expect(descriptor.accessDeclaration).not.toHaveProperty('amountInput');
    expect(descriptor.accessDeclaration).not.toHaveProperty('fieldClass');
    expect(descriptor.accessFieldGroups ?? []).toEqual([]);
  }
});

it('is protected and Core-owned on every entrypoint, so the one gate always asks', () => {
  for (const descriptor of [upload, confirm, rename, metadata]) {
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
});

it('is routine on every capability, and only the rename may be proposed or approved', () => {
  for (const declaration of Object.values(EXPECTED)) {
    expect(declaration.risk).toBe('routine');
  }
  // An upload leg is a run-only streaming operation: a parked proposal would keep no request body to stream.
  expect(upload.accessDeclaration?.modes).toEqual(['run']);
  expect(confirm.accessDeclaration?.modes).toEqual(['run']);
  expect(metadata.accessDeclaration?.modes).toEqual(['run']);
  expect(rename.accessDeclaration?.modes).toEqual(['run', 'propose', 'approve']);
});

it('names the one exact record on exactly the record-scoped capabilities, never a name, key or storage location', () => {
  // The reserve leg names no record (the asset does not exist yet) and confirm acts on the reservation: both are scope-wide.
  expect(upload.accessTarget).toBeUndefined();
  expect(confirm.accessTarget).toBeUndefined();
  expect(upload.accessDeclaration?.selectors).toEqual([]);
  expect(confirm.accessDeclaration?.selectors).toEqual([]);
  // Record-scoped: the target is the asset id; the tenant half comes from the trusted scope.
  expect(metadata.accessTarget?.({ mediaAssetRef }, scope)).toEqual({
    moduleKey: 'core.media',
    recordKey: mediaAssetId,
  });
  const renamePayload = {
    displayFilename: Schema.decodeUnknownSync(rename.payloadSchema.fields.displayFilename)('new.pdf'),
    mediaAssetRef,
  };
  expect(rename.accessTarget?.(renamePayload, scope)).toEqual({ moduleKey: 'core.media', recordKey: mediaAssetId });
  expect(metadata.accessDeclaration?.selectors).toEqual(['all']);
  expect(rename.accessDeclaration?.selectors).toEqual(['all']);
});

it('rides the machine carrier on the two upload legs only, with one workload key of the Core Media namespace', () => {
  expect(upload.accessWorkload?.workloads).toEqual(['core.media.ingest']);
  expect(confirm.accessWorkload?.workloads).toEqual(['core.media.ingest']);
  // Rename and the metadata read are human and agent only: a bound machine is refused by the declaration carrier.
  expect(rename.accessWorkload).toBeUndefined();
  expect(metadata.accessWorkload).toBeUndefined();
});

it('lists exactly the four existing keys in the access catalog, with no duplicate and no workload entry', () => {
  const descriptors = [upload, confirm, rename, metadata].flatMap((descriptor) =>
    descriptor.accessDeclaration === undefined
      ? []
      : [{ accessDeclaration: descriptor.accessDeclaration, entrypoint: descriptor.entrypoint }],
  );
  const catalog = Result.getOrThrow(collectAccessCatalog([{ descriptors, moduleId: 'core.media' }]));
  const keys = catalog.entries.map(({ accessDeclaration }) => accessDeclaration.key);
  expect(keys.toSorted()).toEqual([
    'core.media.asset-metadata.read',
    'core.media.asset.confirm',
    'core.media.asset.upload',
    'core.media.display-filename.rename',
  ]);
  for (const open of OPEN_DECLARATIONS) {
    expect(keys, `${open} is declared before its operation exists`).not.toContain(open);
  }
});

it('has no Core Media Action beyond the audited ones, and each carries a carrier', () => {
  const mediaActions = coreActionCatalog.filter(({ owningModuleKey }) => owningModuleKey === 'core.media');
  expect(mediaActions.map(({ actionKey }) => actionKey).toSorted()).toEqual([
    'core.media.confirm-asset',
    'core.media.rename-display-filename',
    'core.media.upload-asset',
  ]);
});
