import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { ModuleKeySchema, RecordKeySchema } from '../../src/access/ids.ts';
import type { AccessPrincipalKind, AccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import { collectAccessCatalog } from '../../src/authorization/access-declaration.ts';
import { assetMetadataRead, coreActionCatalog, renameDisplayFilenameAction } from '../../src/index.ts';
import { isGenuineCoreOperation } from '../../src/modules/module-operation-execution.ts';
import { MediaDisplayFilenameSchema } from '../../src/media/upload-contract.ts';
import { RenameDisplayFilenamePayloadSchema } from '../../src/media/rename-contract.ts';
import { MediaAssetRefSchema } from '../../src/resources/media-asset.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { at, cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';

/*
 * The two capabilities of lane d20-05, as registered: the metadata read and the display-name rename. Each is its
 * own declaration; neither implies the other, the upload capabilities or the (later) download. What the real
 * access seam answers for each principal kind is asserted here with the scripted decision port; the
 * SpiceDB-backed matrix belongs to d20-08.
 */

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const now = at('2026-11-19T12:00:00Z');
const mediaAssetId = uid(40);

const scopeFor = (principalId: string, authMethod: 'api_key' | 'session'): OperationalScope => {
  const trusted = Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: uid(70),
    authContextRef: `core-media-${authMethod}`,
    authMethod,
    principalId,
    tenantId: tenant,
  });
  return { ...trusted, correlationId: 'core-media-metadata-rename' };
};

it('registers the metadata read as one protected, record-scoped, routine detail read of Core Media', () => {
  const { descriptor } = assetMetadataRead;
  expect(descriptor.readKey).toBe('core.media.api.asset-metadata');
  expect(descriptor.owningModuleKey).toBe('core.media');
  expect(descriptor.entrypoint).toMatchObject({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'core.media.api.asset-metadata',
    moduleKey: 'core.media',
    role: 'api',
  });
  expect(descriptor.accessDeclaration).toEqual({
    key: 'core.media.asset-metadata.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'media', level: 'basic' },
    risk: 'routine',
    selectors: ['all'],
  });
  expect(descriptor.accessKind).toBe('detail');
  expect(descriptor.legalEntityScope).toBe('optional');
  expect(descriptor.evidencePolicy.captureMode).toBe('metadata_only');
  expect(descriptor.policies).toEqual([]);
  // No second carrier, no field group: nothing but the one capability can open it.
  expect(descriptor.accessWorkload).toBeUndefined();
  expect(descriptor.accessFieldGroups).toBeUndefined();
});

it('registers the rename as one protected, record-scoped, routine, idempotent Action of Core Media', () => {
  const { descriptor } = renameDisplayFilenameAction;
  expect(descriptor.actionKey).toBe('core.media.rename-display-filename');
  expect(descriptor.owningModuleKey).toBe('core.media');
  expect(descriptor.entrypoint).toMatchObject({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: 'core.media.rename-display-filename',
    moduleKey: 'core.media',
    role: 'action',
  });
  expect(descriptor.accessDeclaration).toEqual({
    key: 'core.media.display-filename.rename',
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    placement: { group: 'media', level: 'extended' },
    risk: 'routine',
    selectors: ['all'],
  });
  expect(descriptor.idempotency).toBe('required');
  expect(descriptor.legalEntityScope).toBe('optional');
  expect(descriptor.policies).toEqual([]);
  // A rename creates no link, assignment, version or downstream event.
  expect(descriptor.domainEvents).toEqual({});
  expect(descriptor.accessEvidencePolicy.captureMode).toBe('metadata_only');
  expect(descriptor.accessWorkload).toBeUndefined();
  expect(Object.isFrozen(descriptor)).toBe(true);
});

it('is a genuine Core operation, so the Shell host runs it without an owner registration', () => {
  expect(isGenuineCoreOperation(assetMetadataRead)).toBe(true);
  expect(isGenuineCoreOperation(renameDisplayFilenameAction)).toBe(true);
});

it('is in the Core Action catalog exactly once', () => {
  expect(coreActionCatalog.filter(({ actionKey }) => actionKey === 'core.media.rename-display-filename')).toHaveLength(
    1,
  );
});

it('resolves the access record of both capabilities to the exact asset id, never to a name', () => {
  const mediaAssetRef = Schema.decodeUnknownSync(MediaAssetRefSchema)({
    moduleId: 'core.media',
    resourceId: mediaAssetId,
    resourceType: 'core.media.asset',
    tenantId: tenant,
  });
  const callerScope = scopeFor(person, 'session');
  expect(assetMetadataRead.descriptor.accessTarget?.({ mediaAssetRef }, callerScope)).toEqual({
    moduleKey: 'core.media',
    recordKey: mediaAssetId,
  });
  expect(
    renameDisplayFilenameAction.descriptor.accessTarget?.(
      { displayFilename: Schema.decodeUnknownSync(MediaDisplayFilenameSchema)('x.pdf'), mediaAssetRef },
      callerScope,
    ),
  ).toEqual({ moduleKey: 'core.media', recordKey: mediaAssetId });
});

it('adds the two declarations beside the upload ones without a duplicate key', () => {
  const entries = [assetMetadataRead.descriptor, renameDisplayFilenameAction.descriptor].flatMap((descriptor) =>
    descriptor.accessDeclaration === undefined
      ? []
      : [{ accessDeclaration: descriptor.accessDeclaration, entrypoint: descriptor.entrypoint }],
  );
  const catalog = Result.getOrThrow(collectAccessCatalog([{ descriptors: entries, moduleId: 'core.media' }]));
  expect(catalog.entries.map(({ accessDeclaration }) => accessDeclaration.key)).toEqual([
    'core.media.asset-metadata.read',
    'core.media.display-filename.rename',
  ]);
});

it('accepts a safe display name and only the asset ref and the name in the rename payload', () => {
  expect(Object.keys(RenameDisplayFilenamePayloadSchema.fields).toSorted()).toEqual([
    'displayFilename',
    'mediaAssetRef',
  ]);
  const decode = Schema.decodeUnknownResult(RenameDisplayFilenamePayloadSchema);
  const ref = {
    moduleId: 'core.media',
    resourceId: mediaAssetId,
    resourceType: 'core.media.asset',
    tenantId: tenant,
  };
  expect(Result.isSuccess(decode({ displayFilename: 'new.pdf', mediaAssetRef: ref }))).toBe(true);
  // Two assets may share a name, so a repeated, an accented and a spaced name are all fine.
  for (const name of ['manual.pdf', 'Příručka 2026 (v2).pdf', ' padded .txt']) {
    expect(Result.isSuccess(decode({ displayFilename: name, mediaAssetRef: ref }))).toBe(true);
  }
  for (const unsafe of [
    '',
    '   ',
    'a/b.pdf',
    String.raw`a\b.pdf`,
    '..',
    '.',
    'bad\u0000name',
    'line\nbreak',
    'rtl\u202Etxt.exe',
  ]) {
    expect(Result.isFailure(decode({ displayFilename: unsafe, mediaAssetRef: ref }))).toBe(true);
  }
  for (const codePoint of [0x00_ad, 0x03_4f, 0x18_0e, 0x20_60, 0x20_64, 0x20_6a, 0x20_6f, 0xff_f9, 0xff_fb]) {
    const displayFilename = `na${String.fromCodePoint(codePoint)}me.pdf`;
    expect(Result.isFailure(decode({ displayFilename, mediaAssetRef: ref }))).toBe(true);
  }
  // No other field is editable through the payload: unknown keys are not part of the contract.
  const extra = decode({ displayFilename: 'x', mediaAssetRef: ref, mimeType: 'text/plain', originalFilename: 'o' });
  expect(Result.isSuccess(extra) && Object.keys(extra.success).toSorted()).toEqual([
    'displayFilename',
    'mediaAssetRef',
  ]);
});

it('answers the rename with the ref and the new name only', () => {
  expect(Object.keys(renameDisplayFilenameAction.descriptor.resultSchema.fields).toSorted()).toEqual([
    'displayFilename',
    'mediaAssetRef',
  ]);
});

const harness = (options: { readonly capability?: string; readonly kind: AccessPrincipalKind }) => {
  const authoritySpec = {
    cells: options.capability === undefined ? [] : [cell({ capability: options.capability })],
  };
  const authority = makeAuthority(authoritySpec);
  const check = makeCheck({ authority: authoritySpec });
  const kinds: AccessPrincipalKinds = { readKind: () => Effect.succeed(Option.some(options.kind)) };
  return makeAccessDecisionService({
    authorityFor: () => authority.port,
    check: check.port,
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed([]) },
    principalKinds: kinds,
    privacyDispatchLiveness: { read: () => Effect.succeed(false) },
    workloadBindings: { readActiveWorkloadKeys: () => Effect.succeed(new Set<string>()) },
  });
};

const registrations = [assetMetadataRead, renameDisplayFilenameAction] as const;
const gateInputOf = (registration: (typeof registrations)[number], principalId: string): GateInput => ({
  carrier: registration.descriptor,
  legalEntityScope: registration.descriptor.legalEntityScope,
  now,
  scope: scopeFor(principalId, 'session'),
  target: { moduleKey: ModuleKeySchema.make('core.media'), recordKey: RecordKeySchema.make(mediaAssetId) },
});
const keyOf = (registration: (typeof registrations)[number]) => registration.descriptor.accessDeclaration?.key ?? '';

it.effect('admits a human with the capability and never without it, and keeps the two capabilities apart', () =>
  Effect.gen(function* separate() {
    for (const registration of registrations) {
      const granted = yield* harness({ capability: keyOf(registration), kind: 'human' }).decide(
        gateInputOf(registration, person),
      );
      expect(granted.outcome).toBe('ALLOWED');
      const ungranted = yield* harness({ kind: 'human' }).decide(gateInputOf(registration, person));
      expect(ungranted.outcome).toBe('DENIED');
    }
    // Reading the metadata is not renaming, and renaming is not reading the metadata.
    const readOnly = harness({ capability: keyOf(assetMetadataRead), kind: 'human' });
    expect((yield* readOnly.decide(gateInputOf(renameDisplayFilenameAction, person))).outcome).toBe('DENIED');
    const renameOnly = harness({ capability: keyOf(renameDisplayFilenameAction), kind: 'human' });
    expect((yield* renameOnly.decide(gateInputOf(assetMetadataRead, person))).outcome).toBe('DENIED');
    // The upload and confirm capabilities open neither.
    for (const upload of ['core.media.asset.upload', 'core.media.asset.confirm']) {
      const uploader = harness({ capability: upload, kind: 'human' });
      for (const registration of registrations) {
        expect((yield* uploader.decide(gateInputOf(registration, person))).outcome).toBe('DENIED');
      }
    }
  }),
);

it.effect('never admits a machine principal on its kind or origin: these two are human and agent capabilities', () =>
  Effect.gen(function* machines() {
    for (const registration of registrations) {
      for (const kind of ['integration', 'service', 'system'] as const) {
        const refused = yield* harness({ capability: keyOf(registration), kind }).decide(
          gateInputOf(registration, uid(80)),
        );
        expect(refused.outcome).toBe('DENIED');
      }
    }
  }),
);
