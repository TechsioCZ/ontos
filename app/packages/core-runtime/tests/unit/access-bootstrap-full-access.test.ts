import { DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  FULL_ACCESS_ROLE_NAME,
  FULL_ACCESS_ROLE_TEMPLATE_KEY,
  compileFullAccessRole,
  fullAccessRoleIntent,
} from '../../src/access/bootstrap/full-access-role.ts';
import {
  bootstrapScopesOf,
  legalEntityScopeId,
  ownerAssignmentIncarnationId,
  tenantContextScopeId,
} from '../../src/access/bootstrap/persistence.ts';
import { grantIncarnationId } from '../../src/access/intent/grant-incarnations.ts';
import { stableUuid } from '../../src/access/catalog/stable-id.ts';
import {
  AccessScopeIdSchema,
  CapabilityKeySchema,
  CatalogDigestSchema,
  CatalogSnapshotIdSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  RoleIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import { cellSlotKey } from '../../src/access/model.ts';
import type { AccessMode, CatalogSnapshot, CatalogSnapshotEntry, RecordSelector } from '../../src/access/model.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { buildAccessCatalogRelease } from '../../src/access/catalog/release.ts';
import { collectAccessCatalog } from '../../src/authorization/access-declaration.ts';

/*
 * "Plný přístup" is a tenant's first role (O67-Q6), so it has to be exactly as wide as the release it is
 * pinned to and never wider: every capability of the catalog, every mode it declares, and the widest record
 * selector it declares. This suite holds it to that, and holds the bootstrap's derived identifiers to being
 * stable — a repeated bootstrap must resume the rows it wrote, not create neighbours (D27).
 */
const tenantId = TenantIdSchema.make('00000000-0000-4000-8000-000000000001');
const catalogId = CatalogSnapshotIdSchema.make('00000000-0000-4000-8000-000000000002');
const roleId = RoleIdSchema.make('00000000-0000-4000-8000-000000000003');
const company = LegalEntityIdSchema.make('00000000-0000-4000-8000-000000000004');
const scopeA = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000005');
const scopeB = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000006');

const entry = (input: {
  readonly key: string;
  readonly modes: readonly [AccessMode, ...AccessMode[]];
  readonly risk: CatalogSnapshotEntry['risk'];
  readonly selectors: readonly RecordSelector[];
}): CatalogSnapshotEntry => ({
  key: CapabilityKeySchema.make(input.key),
  kind: 'read',
  modes: input.modes,
  moduleKey: ModuleKeySchema.make('test.access'),
  placement: { group: 'invoices', level: 'basic' },
  risk: input.risk,
  selectors: [...input.selectors],
});

const catalogOf = (entries: readonly CatalogSnapshotEntry[]): CatalogSnapshot => ({
  digest: CatalogDigestSchema.make('a'.repeat(64)),
  entries: [...entries],
  id: catalogId,
  publishedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T09:00:00Z')),
});

const entries = [
  entry({ key: 'test.access.invoice.read', modes: ['run'], risk: 'routine', selectors: [] }),
  entry({ key: 'test.access.invoice.void', modes: ['run', 'propose', 'approve'], risk: 'critical', selectors: [] }),
  // The widest declared selector is the one the owner holds, never a narrower default (O2, O10).
  entry({ key: 'test.access.invoice.export', modes: ['run'], risk: 'sensitive', selectors: ['assigned', 'all'] }),
  entry({ key: 'test.access.contact.read', modes: ['run'], risk: 'routine', selectors: ['entrusted', 'assigned'] }),
  entry({ key: 'test.access.contact.note', modes: ['run', 'propose'], risk: 'sensitive', selectors: ['team'] }),
] as const;

it('omits workload-only module purposes from the catalog and full-access owner without narrowing human capabilities', () => {
  const accessActor = {
    callers: ['operations-client'],
    reason: 'A registered client workload uses this purpose only through a verified module call',
    subject: 'workload',
    subjectWorkloads: ['operations.client-intake'],
  } as const;
  const action = defineAction(
    {
      accessActor,
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.access.intake.create.evidence' },
      actionKey: 'test.access.intake.create',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'protected' },
        entrypointKey: 'test.access.intake.create',
        moduleKey: 'test.access',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: 'test.access',
      payloadSchema: Schema.Struct({}),
      policies: [],
      resultSchema: Schema.Struct({}),
      schemaVersion: '1',
    },
    () => Effect.die('Catalog collection never executes an owner Action'),
  );
  const read = defineRead(
    {
      accessActor,
      accessKind: 'detail',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'protected' },
        entrypointKey: 'test.access.intake.review',
        moduleKey: 'test.access',
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.access.intake.review.evidence' },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'required',
      owningModuleKey: 'test.access',
      policies: [],
      readKey: 'test.access.intake.review',
      resultSchema: Schema.Struct({}),
      schemaVersion: '1',
    },
    () => Effect.die('Catalog collection never executes an owner Read'),
    () => Effect.succeed({}),
  );
  const human = {
    accessDeclaration: {
      key: 'test.access.invoice.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'invoices', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'test.access.invoice.read',
      moduleKey: 'test.access',
      role: 'api',
    }),
  } as const;
  const modules = [{ descriptors: [action.descriptor, read.descriptor, human], moduleId: 'test.access' }];
  const catalog = Result.getOrThrow(collectAccessCatalog(modules));
  expect(catalog.entries.map(({ accessDeclaration }) => accessDeclaration.key)).toEqual(['test.access.invoice.read']);
  const release = Result.getOrThrow(
    buildAccessCatalogRelease({
      installedModuleKeys: [ModuleKeySchema.make('test.access')],
      modules,
      publishedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T00:00:00Z')),
    }),
  );
  expect(fullAccessRoleIntent(release).switches.map(({ capabilityKey }) => capabilityKey)).toEqual([
    'test.access.invoice.read',
  ]);
  expect(Result.getOrThrow(compileFullAccessRole(release)).cells.map(({ capabilityKey }) => capabilityKey)).toEqual([
    'test.access.invoice.read',
  ]);
  // Even raw catalog metadata cannot add a human permission beside the exclusive module workload.
  const mixed = {
    ...read.descriptor,
    accessDeclaration: { ...human.accessDeclaration, key: 'test.access.intake.review' },
  };
  expect(Result.isFailure(collectAccessCatalog([{ descriptors: [mixed], moduleId: 'test.access' }]))).toBe(true);
  expect(
    Result.isFailure(
      buildAccessCatalogRelease({
        installedModuleKeys: [ModuleKeySchema.make('test.access')],
        modules: [{ descriptors: [mixed], moduleId: 'test.access' }],
        publishedAt: release.publishedAt,
      }),
    ),
  ).toBe(true);
});

it.effect('names every capability of the release as its own switch at the widest declared selector', () =>
  Effect.sync(() => {
    const intent = fullAccessRoleIntent(catalogOf(entries));
    expect(intent.templateKey).toBe(FULL_ACCESS_ROLE_TEMPLATE_KEY);
    // A level row would grant only the routine half; full access names every capability (P1, P2).
    expect(intent.rows).toEqual([]);
    expect(intent.limits).toEqual([]);
    expect(intent.switches.map(({ capabilityKey, selector }) => [capabilityKey, selector])).toEqual([
      ['test.access.invoice.read', 'all'],
      ['test.access.invoice.void', 'all'],
      ['test.access.invoice.export', 'all'],
      ['test.access.contact.read', 'entrusted'],
      ['test.access.contact.note', 'team'],
    ]);
    expect(FULL_ACCESS_ROLE_NAME).toBe('Plný přístup');
  }),
);

it.effect('compiles one cell per declared mode, pinned to the release it was built from', () =>
  Effect.sync(() => {
    const compiled = Result.getOrThrow(compileFullAccessRole(catalogOf(entries)));
    expect(compiled.catalogSnapshotId).toBe(catalogId);
    expect(compiled.templateKey).toBe(FULL_ACCESS_ROLE_TEMPLATE_KEY);
    expect(compiled.cells.map((cell) => `${cell.capabilityKey} ${cell.mode}`)).toEqual([
      'test.access.contact.note propose',
      'test.access.contact.note run',
      'test.access.contact.read run',
      'test.access.invoice.export run',
      'test.access.invoice.read run',
      'test.access.invoice.void approve',
      'test.access.invoice.void propose',
      'test.access.invoice.void run',
    ]);
    // One cell per slot: the engine reads a duplicated slot as a union of two grants.
    expect(new Set(compiled.cells.map(cellSlotKey)).size).toBe(compiled.cells.length);
    expect(compiled.cells.every(({ amountCeiling }) => amountCeiling === undefined)).toBe(true);
  }),
);

it.effect('refuses a role whose switches belong to another release', () =>
  Effect.sync(() => {
    // The intent is built against a release that carries one capability more than the one being pinned:
    // the compiler must refuse the unknown key instead of granting a subset of it silently (guarantee 2).
    const richer = compileFullAccessRole(
      catalogOf([
        ...entries,
        entry({ key: 'test.access.invoice.pay', modes: ['run'], risk: 'critical', selectors: [] }),
      ]),
    );
    expect(Result.isSuccess(richer)).toBe(true);
    const narrower = compileFullAccessRole(catalogOf(entries.slice(0, 2)));
    expect(Result.isSuccess(narrower)).toBe(true);
    const mixed = Result.getOrThrow(compileFullAccessRole(catalogOf(entries)));
    expect(
      mixed.cells.some(({ capabilityKey }) => capabilityKey === CapabilityKeySchema.make('test.access.invoice.pay')),
    ).toBe(false);
  }),
);

it.effect('derives the tenant, company and grant identities a repeated bootstrap resumes', () =>
  Effect.sync(() => {
    const scopes = bootstrapScopesOf(tenantId, [company]);
    // The tenant context first, then one scope per company: both named by what they are, not by a slug.
    expect(scopes.map(({ scopeId }) => scopeId)).toEqual([
      tenantContextScopeId(tenantId),
      legalEntityScopeId(tenantId, company),
    ]);
    expect(scopes[0]?.scopeId).toBe(tenantContextScopeId(tenantId));
    // A tenant context and a company never share a scope, and neither is a legal entity named by the other.
    expect(scopes[0]?.scopeId).not.toBe(scopes[1]?.scopeId);
    expect(bootstrapScopesOf(tenantId, [company])).toEqual(scopes);
    expect(bootstrapScopesOf(TenantIdSchema.make('00000000-0000-4000-8000-000000000009'), [company])).not.toEqual(
      scopes,
    );

    expect(ownerAssignmentIncarnationId(tenantId, scopeA, roleId)).toBe(
      ownerAssignmentIncarnationId(tenantId, scopeA, roleId),
    );
    expect(ownerAssignmentIncarnationId(tenantId, scopeA, roleId)).not.toBe(
      ownerAssignmentIncarnationId(tenantId, scopeB, roleId),
    );

    const cell = {
      capabilityKey: CapabilityKeySchema.make('test.access.invoice.read'),
      mode: 'run' as const,
      selector: { _tag: 'all' } as const,
    };
    const grant = (scopeId: typeof scopeA) => grantIncarnationId({ cell, roleId, scopeId, tenantId });
    expect(grant(scopeA)).toBe(grant(scopeA));
    expect(grant(scopeA)).not.toBe(grant(scopeB));
    expect(grant(scopeA)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    // A stable identifier is a UUID, and two different seeds never collide.
    expect(stableUuid('ontos.access.one')).not.toBe(stableUuid('ontos.access.two'));
    expect(stableUuid('ontos.access.one')).toBe(stableUuid('ontos.access.one'));
  }),
);
