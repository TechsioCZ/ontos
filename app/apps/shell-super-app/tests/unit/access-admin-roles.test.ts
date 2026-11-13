import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import {
  AccessOperationIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  DelegationIdSchema,
} from '@app/core-runtime/access/ids';
import type {
  AccessChangesState,
  AccessChangesStoreService,
  Assignment,
  CatalogSnapshot,
  CatalogSnapshotEntry,
  Cell,
  Role,
  RoleRevision,
} from '@app/core-runtime/access/changes/role-revision';
import {
  AccessChangesStore,
  AccessScopeIdSchema,
  AssignmentSchema,
  CatalogSnapshotEntrySchema,
  CatalogSnapshotSchema,
  CellSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionSchema,
  RoleSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/changes/role-revision';
import type { TenantIntentLoaderService } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { TenantIntentLoader } from '@app/core-runtime/access/intent/tenant-intent-loader';
import type { AccessProjectionWriterService } from '@app/core-runtime/access/intent/projection-writer';
import { AccessProjectionWriter } from '@app/core-runtime/access/intent/projection-writer';
import { DateTime, Effect, Layer, Option, Result, Schema } from 'effect';

import { expect, it } from 'effect-rstest';

import type { AccessAdminProblem } from '../../shared/access-admin-api.ts';
import {
  CreateAccessRolePayloadSchema,
  AccessPageSchema,
  SaveAccessRoleEditPayloadSchema,
  GetAccessRolePayloadSchema,
  AccessRoleEditPayloadSchema,
} from '../../shared/access-admin-api.ts';
import type { AccessAdminRolesBffService } from '../../api/access-admin/roles.ts';
import { AccessAdminClock } from '../../api/access-admin/clock.ts';
import {
  AccessAdminRolesBff,
  AccessAdminRolesBffLive,
  accessRolesDeclarations,
  accessRolesEntrypoints,
  accessRolesFailureProblem,
} from '../../api/access-admin/roles.ts';
import {
  AccessAdminSession,
  accessAdminAuthenticationRequiredProblem,
  accessAdminSavedPendingProblem,
} from '../../api/access-admin/session.ts';
import type { OperationalScope } from '@app/core-runtime';

/*
 * The Role editor BFF (P2) as the browser sees it: the list, one role with its holders, the pinned
 * templates, the preview and the two writes. Every test drives the real service over scripted ports,
 * so the assertions are about this module's own decisions — which cells it accepts, which token it
 * insists on, what it writes and what it refuses to write — and not about a database.
 */

const uuid = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const TENANT = uuid(1);
const SCOPE = uuid(2);
const CATALOG = uuid(3);
const PERSON = uuid(4);
const ROLE = uuid(20);
const OTHER_ROLE = uuid(21);
const REVISION = uuid(40);
const INCARNATION = uuid(50);

/** A fixture value decoded by the schema that owns it: a bad fixture fails the suite immediately. */
class FixtureInvalid extends Schema.TaggedError<FixtureInvalid>()('FixtureInvalid', { reason: Schema.String }) {}

const decode = <Value, Input>(schema: Schema.Decoder<Value>, input: Input): Value => {
  const decoded = Schema.decodeUnknownResult(schema)(input);
  if (Result.isFailure(decoded)) {
    throw new FixtureInvalid({ reason: `fixture is invalid: ${decoded.failure.message}` });
  }
  return decoded.success;
};

const scope: OperationalScope = Object.freeze({
  authBindingId: 'binding-1',
  authContextRef: 'session-1',
  authMethod: 'session' as const,
  correlationId: 'p2-roles-bff',
  principalId: PrincipalIdSchema.make(PERSON),
  tenantId: TenantIdSchema.make(TENANT),
});

const instant = (hour: number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 3, hour)));
const NOW = instant(9);

const entry = (input: {
  readonly amountInput?: string;
  readonly key: string;
  readonly kind?: string;
  readonly risk?: string;
}): CatalogSnapshotEntry => {
  const base = {
    key: input.key,
    kind: input.kind ?? 'action',
    modes: ['run', 'propose', 'approve'],
    moduleKey: 'test',
    placement: { group: 'parties', level: 'basic' },
    risk: input.risk ?? 'routine',
    selectors: ['all'],
  };
  const withAmount = input.amountInput === undefined ? base : { ...base, amountInput: input.amountInput };
  return decode(CatalogSnapshotEntrySchema, withAmount);
};

const READ = entry({ key: 'test.party.read' });
const PAY = entry({ amountInput: 'amount', key: 'test.invoice.pay', risk: 'critical' });
const ADMIN = entry({ key: 'test.tenant.configure', kind: 'admin', risk: 'sensitive' });

const catalog = decode(CatalogSnapshotSchema, {
  digest: 'a'.repeat(64),
  entries: [READ, PAY, ADMIN],
  id: CATALOG,
  publishedAt: instant(1),
});

const cell = (capabilityKey: string, mode = 'run', selector = 'all'): Cell =>
  decode(CellSchema, { capabilityKey, mode, selector: { _tag: selector } });

const role = (id = ROLE): Role =>
  decode(RoleSchema, { createdAt: instant(0), createdBy: PERSON, id, name: 'Účetní', tenantId: TENANT });

const revision = (cells: readonly Cell[], roleId = ROLE): RoleRevision =>
  decode(RoleRevisionSchema, {
    catalogSnapshotId: CATALOG,
    cells,
    createdAt: instant(0),
    createdBy: PERSON,
    id: roleId === ROLE ? REVISION : uuid(41),
    provenance: 'manual',
    revision: 1,
    roleId,
    tenantId: TENANT,
  });

const assignment = (roleId = ROLE): Assignment =>
  decode(AssignmentSchema, {
    assignedAt: instant(0),
    assignedBy: PERSON,
    holder: { _tag: 'Principal', principalId: PERSON },
    incarnationId: INCARNATION,
    roleId,
    roleRevisionId: roleId === ROLE ? REVISION : uuid(41),
    scopeId: SCOPE,
    status: 'active',
    tenantId: TENANT,
    validFrom: instant(0),
  });

const changesState = (
  entries: readonly { readonly headRevision: RoleRevision; readonly role: Role }[],
): AccessChangesState => ({
  decisions: [],
  items: [],
  revisions: entries.map(({ headRevision }) => headRevision),
  roles: entries.map(({ headRevision, role: one }) => ({ revision: headRevision, role: one })),
});

type ProjectionIntent = Effect.Success<ReturnType<TenantIntentLoaderService['loadProjection']>>;
type ConfigureBases = Effect.Success<ReturnType<TenantIntentLoaderService['loadConfigureBases']>>;

const intent = (assignments: readonly Assignment[]): ProjectionIntent => ({
  catalogEntries: [READ, PAY, ADMIN],
  coverage: 'complete',
  legalEntities: [],
  members: [],
  owners: [PrincipalIdSchema.make(PERSON)],
  principals: [{ kind: 'human', principalId: PERSON }],
  scopes: [
    {
      assignments: [...assignments],
      connections: [],
      delegations: [],
      installations: [],
      roleRevisions: [],
      scope: {
        id: AccessScopeIdSchema.make(SCOPE),
        scope: { _tag: 'TenantContext', tenantId: TenantIdSchema.make(TENANT) },
      },
    },
  ],
  suspended: [],
  tenantId: TenantIdSchema.make(TENANT),
});

interface FixtureInput {
  readonly assignments?: readonly Assignment[];
  /** The author's configure bases as live intent reads them at the write; an owner by default. */
  readonly bases?: ConfigureBases;
  readonly catalog?: CatalogSnapshot;
  readonly gate?: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';
  readonly roles?: readonly { readonly headRevision: RoleRevision; readonly role: Role }[];
  readonly session?: 'tenant' | 'anonymous';
}

interface Recorded {
  creates: unknown[];
  reconciles: number;
  revisions: unknown[];
}

/** A store method this suite never calls: reaching it is a defect, not a silent success. */
const unusedStoreCall = () => Effect.die(new FixtureInvalid({ reason: 'this suite never calls this method' }));

const authenticationRequired = (): AccessAdminProblem => accessAdminAuthenticationRequiredProblem();

const fixture = (input: FixtureInput = {}) => {
  const roles = input.roles ?? [{ headRevision: revision([cell('test.party.read')]), role: role() }];
  const assignments = input.assignments ?? [assignment()];
  const recorded: Recorded = {
    creates: [],
    reconciles: 0,
    revisions: [],
  };

  const store: AccessChangesStoreService = {
    loadPublishedCatalog: () => Effect.succeed(Option.some(input.catalog ?? catalog)),
    loadTenantChanges: () => Effect.succeed(changesState(roles)),
    publishCatalog: unusedStoreCall,
    recordAdoption: unusedStoreCall,
    recordChangeItems: unusedStoreCall,
    recordDecline: unusedStoreCall,
    recordRole: (request) =>
      Effect.sync(() => {
        recorded.creates.push(request);
      }),
    recordRoleRevision: (request) =>
      Effect.sync(() => {
        recorded.revisions.push(request);
      }),
    recordUndo: unusedStoreCall,
  };

  const loader: TenantIntentLoaderService = {
    loadAuthorityCells: () => Effect.succeed([]),
    loadAuthorityCellsMany: (_scope, queries) => Effect.succeed(queries.map(() => [])),
    loadConfigureBases: () => Effect.succeed(input.bases ?? [{ _tag: 'Owner' }]),
    loadConnection: () => Effect.succeed(Option.none()),
    loadProjection: () => Effect.succeed(intent(assignments)),
    loadScope: () => Effect.succeed(Option.none()),
    loadTeamIds: () => Effect.succeed([]),
    loadTenantContextScopeId: () => Effect.succeed(Option.none()),
  };

  const writer: AccessProjectionWriterService = {
    reconcileTenant: ({ scope: requestScope }) =>
      Effect.sync(() => {
        recorded.reconciles += 1;
        return {
          deletions: 0,
          digest: CommandDigestSchema.make('b'.repeat(64)),
          operationId: AccessOperationIdSchema.make(uuid(90)),
          projectionToken: 'projected:1',
          resumed: false,
          scopeId: AccessScopeIdSchema.make(requestScope.tenantId),
          touches: 2,
          units: ['tenant'],
          verified: true,
        };
      }),
  };

  const gate =
    (input.gate ?? 'ALLOWED') === 'UNAVAILABLE'
      ? makeTestAccessDecision({ unavailable: true })
      : makeTestAccessDecision(
          (input.gate ?? 'ALLOWED') === 'DENIED'
            ? { defaultAnswer: { outcome: 'DENIED' } }
            : { defaultAnswer: { outcome: 'ALLOWED' } },
        );

  const fixedClock = { now: Effect.succeed(NOW) };

  const session = input.session === 'anonymous' ? Effect.fail(authenticationRequired()) : Effect.succeed(scope);

  const sessionPort = { requireTenantContext: () => session };
  const runtime = Layer.mergeAll(
    Layer.succeed(AccessAdminSession, sessionPort),
    Layer.succeed(AccessDecisionGate, gate),
    Layer.succeed(AccessChangesStore, store),
    Layer.succeed(TenantIntentLoader, loader),
    Layer.succeed(AccessProjectionWriter, writer),
    Layer.succeed(AccessAdminClock, fixedClock),
  );
  const bff: Effect.Effect<AccessAdminRolesBffService> = AccessAdminRolesBff.pipe(
    Effect.provide(AccessAdminRolesBffLive.pipe(Layer.provide(runtime))),
  );

  const run = <Value, Failure>(effect: (bff: AccessAdminRolesBffService) => Effect.Effect<Value, Failure>) =>
    bff.pipe(Effect.flatMap((service) => effect(service)));

  return { bff, recorded, run };
};

const headers = new Headers({ 'idempotency-key': 'key-1' });

const listPayload = (cursor?: string) =>
  decode(AccessPageSchema, cursor === undefined ? { limit: 10 } : { cursor, limit: 10 });

const templatesPayload = () => decode(AccessPageSchema, { limit: 50 });

const editPayload = (input: {
  readonly cells: readonly unknown[];
  readonly expectedRoleRevisionId?: string;
  readonly roleId?: string;
}) =>
  decode(AccessRoleEditPayloadSchema, {
    catalogSnapshotId: CATALOG,
    cells: input.cells,
    expectedRoleRevisionId: input.expectedRoleRevisionId ?? REVISION,
    roleId: input.roleId ?? ROLE,
  });

const savePayload = (input: {
  readonly cells: readonly unknown[];
  readonly confirmedEffects?: readonly { readonly effect: string; readonly slot: string }[];
  readonly expectedRoleRevisionId?: string;
  readonly previewToken: string;
}) =>
  decode(SaveAccessRoleEditPayloadSchema, {
    catalogSnapshotId: CATALOG,
    cells: input.cells,
    confirmedEffects: [...(input.confirmedEffects ?? [])],
    expectedRoleRevisionId: input.expectedRoleRevisionId ?? REVISION,
    previewToken: input.previewToken,
    roleId: ROLE,
  });

it.effect('lists the tenant roles with their cells and holder counts, without a selected company', () =>
  Effect.gen(function* listRoles() {
    const { run } = fixture();
    const response = yield* run((bff) => bff.list(headers, listPayload()));
    expect(response.items.length).toBe(1);
    expect(response.items[0]?.id).toBe(ROLE);
    expect(response.items[0]?.scope).toBe('tenant');
    expect(response.items[0]?.holderCount).toBe(1);
    expect(response.items[0]?.cells.map(({ capabilityKey }) => capabilityKey)).toEqual(['test.party.read']);
    expect(response.nextCursor).toBeNull();
  }),
);

it.effect('refuses a denied gate with 403 and an unavailable gate with a retryable 503, never a denial', () =>
  Effect.gen(function* gateOutcomes() {
    const denied = yield* fixture({ gate: 'DENIED' })
      .run((bff) => bff.list(headers, listPayload()))
      .pipe(Effect.flip);
    expect(denied.status).toBe(403);

    const unavailable = yield* fixture({ gate: 'UNAVAILABLE' })
      .run((bff) => bff.list(headers, listPayload()))
      .pipe(Effect.flip);
    expect(unavailable.status).toBe(503);

    const anonymous = yield* fixture({ session: 'anonymous' })
      .run((bff) => bff.list(headers, listPayload()))
      .pipe(Effect.flip);
    expect(anonymous.status).toBe(401);
  }),
);

it.effect('answers one role with the people it reaches, and refuses an unknown role without naming it', () =>
  Effect.gen(function* roleDetail() {
    const { run } = fixture();
    const detail = yield* run((bff) => bff.detail(headers, decode(GetAccessRolePayloadSchema, { roleId: ROLE })));
    expect(detail.role.id).toBe(ROLE);
    expect(detail.holderCount).toBe(1);
    expect(detail.holders.length).toBe(1);
    expect(detail.holders[0]?.assignmentIncarnationId).toBe(INCARNATION);
    expect(detail.holders[0]?.roleId).toBe(ROLE);

    const unknown = yield* run((bff) =>
      bff.detail(headers, decode(GetAccessRolePayloadSchema, { roleId: OTHER_ROLE })),
    ).pipe(Effect.flip);
    expect(unknown.status).toBe(403);
  }),
);

it.effect('offers the pinned release with an empty, a full-access and a copy template', () =>
  Effect.gen(function* roleTemplates() {
    const { run } = fixture();
    const response = yield* run((bff) => bff.templates(headers, templatesPayload()));
    expect(response.catalogSnapshotId).toBe(CATALOG);
    expect(response.entries.map(({ capabilityKey }) => capabilityKey)).toEqual([
      'test.party.read',
      'test.invoice.pay',
      'test.tenant.configure',
    ]);
    const sources = response.templates.map(({ source }) => source);
    expect(sources).toContain('blank');
    expect(sources).toContain('catalog_full_access');
    expect(sources).toContain('copy_role');
    const blank = response.templates.find(({ source }) => source === 'blank');
    expect(blank?.cells).toEqual([]);
    const copy = response.templates.find(({ source }) => source === 'copy_role');
    expect(copy?.sourceRoleId).toBe(ROLE);
  }),
);

it.effect('previews an edit with its affected people, the successor cells and a token, before any confirmation', () =>
  Effect.gen(function* previewEdit() {
    const { run } = fixture();
    const payload = editPayload({ cells: [cell('test.party.read'), cell('test.invoice.pay')] });
    const preview = yield* run((bff) => bff.preview(headers, payload));
    expect(preview.changes).toBe(true);
    expect(preview.cells.map(({ capabilityKey }) => capabilityKey)).toEqual(['test.party.read', 'test.invoice.pay']);
    expect(preview.dangerous.map(({ slot }) => slot)).toEqual(['test.invoice.pay run all']);
    expect(preview.requiresNamedEffect).toBe(true);
    expect(preview.affectedHumanCount).toBe(1);
    expect(preview.affectedHolders[0]?.roleId).toBe(ROLE);
    expect(preview.previewToken).toMatch(/^[a-f0-9]{64}$/u);
  }),
);

it.effect('saves the exact previewed cells, writes one fenced revision and answers the new one', () =>
  Effect.gen(function* saveEdit() {
    const { recorded, run } = fixture();
    const cells = [cell('test.party.read'), cell('test.invoice.pay')];
    const preview = yield* run((bff) => bff.preview(headers, editPayload({ cells })));
    const [danger] = preview.dangerous;
    expect(danger).toBeDefined();
    const saved = yield* run((bff) =>
      bff.save({
        headers,
        idempotencyKey: 'key-1',
        payload: savePayload({
          cells,
          confirmedEffects: [{ effect: String(danger?.effect), slot: String(danger?.slot) }],
          previewToken: preview.previewToken,
        }),
      }),
    );
    expect(recorded.reconciles).toBe(1);
    expect(recorded.revisions.length).toBe(1);
    expect(saved.role.revision).toBe(2);
    expect(saved.added.map(({ capabilityKey }) => capabilityKey)).toEqual(['test.invoice.pay']);
    expect(saved.removed).toEqual([]);
    expect(saved.affectedHolderCount).toBe(1);
  }),
);

it.effect('refuses a delegated manager a cell outside their envelope even though the gate admitted the save', () =>
  Effect.gen(function* refuseOutsideEnvelope() {
    // The session person manages ROLE for someone else, but the delegation names only the read capability.
    const delegation = {
      capabilityKeys: [CapabilityKeySchema.make('test.party.read')] as const,
      grantedBy: PrincipalIdSchema.make(uuid(5)),
      id: DelegationIdSchema.make(uuid(60)),
      managerId: PrincipalIdSchema.make(PERSON),
      people: [PrincipalIdSchema.make(uuid(7))] as const,
      roleIds: [RoleIdSchema.make(ROLE)] as const,
      scopeId: AccessScopeIdSchema.make(SCOPE),
      status: 'active' as const,
      tenantId: TenantIdSchema.make(TENANT),
      validFrom: instant(0),
      validUntil: instant(23),
    };
    const { recorded, run } = fixture({
      assignments: [],
      bases: [
        {
          _tag: 'DelegatedManager',
          delegation,
          scope: {
            id: AccessScopeIdSchema.make(SCOPE),
            scope: { _tag: 'TenantContext', tenantId: TenantIdSchema.make(TENANT) },
          },
        },
      ],
    });
    const cells = [cell('test.party.read'), cell('test.invoice.pay')];
    const preview = yield* run((bff) => bff.preview(headers, editPayload({ cells })));
    const [danger] = preview.dangerous;
    const refused = yield* run((bff) =>
      bff.save({
        headers,
        idempotencyKey: 'key-1',
        payload: savePayload({
          cells,
          confirmedEffects: [{ effect: String(danger?.effect), slot: String(danger?.slot) }],
          previewToken: preview.previewToken,
        }),
      }),
    ).pipe(Effect.flip);
    expect(refused.status).toBe(403);
    expect(refused.detail).toContain('access_changes_delegation_out_of_envelope');
    expect(refused.detail).toContain('test.invoice.pay');
    expect(recorded.revisions).toEqual([]);
    expect(recorded.reconciles).toBe(0);
  }),
);

it.effect('refuses a save built on a stale token, a moved revision or a moved release, and writes nothing', () =>
  Effect.gen(function* refuseStaleSave() {
    const { recorded, run } = fixture();
    const cells = [cell('test.party.read'), cell('test.invoice.pay')];

    const staleToken = yield* run((bff) =>
      bff.save({ headers, idempotencyKey: 'key-1', payload: savePayload({ cells, previewToken: 'c'.repeat(64) }) }),
    ).pipe(Effect.flip);
    expect(staleToken.status).toBe(409);

    const staleRevision = yield* run((bff) =>
      bff.save({
        headers,
        idempotencyKey: 'key-1',
        payload: savePayload({ cells, expectedRoleRevisionId: OTHER_ROLE, previewToken: 'c'.repeat(64) }),
      }),
    ).pipe(Effect.flip);
    expect(staleRevision.status).toBe(409);

    const movedRelease = yield* run((bff) =>
      bff.save({
        headers,
        idempotencyKey: 'key-1',
        payload: decode(SaveAccessRoleEditPayloadSchema, {
          catalogSnapshotId: OTHER_ROLE,
          cells,
          confirmedEffects: [],
          expectedRoleRevisionId: REVISION,
          previewToken: 'c'.repeat(64),
          roleId: ROLE,
        }),
      }),
    ).pipe(Effect.flip);
    expect(movedRelease.status).toBe(409);

    expect(recorded.revisions).toEqual([]);
    expect(recorded.reconciles).toBe(0);
  }),
);

it.effect('refuses a dangerous cell the editor did not confirm, and writes nothing', () =>
  Effect.gen(function* refuseUnconfirmed() {
    const { recorded, run } = fixture();
    const cells = [cell('test.party.read'), cell('test.invoice.pay')];
    const preview = yield* run((bff) => bff.preview(headers, editPayload({ cells })));
    const refused = yield* run((bff) =>
      bff.save({
        headers,
        idempotencyKey: 'key-1',
        payload: savePayload({ cells, previewToken: preview.previewToken }),
      }),
    ).pipe(Effect.flip);
    expect(refused.status).toBe(422);
    expect(recorded.revisions).toEqual([]);
  }),
);

it.effect('creates an empty role and refuses any cells at creation, so cells only come through the editor', () =>
  Effect.gen(function* createRole() {
    const { recorded, run } = fixture();
    const created = yield* run((bff) =>
      bff.create({
        headers,
        idempotencyKey: 'key-2',
        payload: decode(CreateAccessRolePayloadSchema, {
          catalogSnapshotId: CATALOG,
          cells: [],
          name: 'Kontrolor',
          scope: { kind: 'tenant' },
          templateKey: 'blank',
        }),
      }),
    );
    expect(created.name).toBe('Kontrolor');
    expect(created.scope).toBe('tenant');
    expect(created.revision).toBe(1);
    expect(created.cells).toEqual([]);
    expect(recorded.creates.length).toBe(1);
    expect(recorded.reconciles).toBe(1);

    const inflated = yield* run((bff) =>
      bff.create({
        headers,
        idempotencyKey: 'key-3',
        payload: decode(CreateAccessRolePayloadSchema, {
          catalogSnapshotId: CATALOG,
          cells: [cell('test.invoice.pay')],
          name: 'Kontrolor',
          scope: { kind: 'tenant' },
          templateKey: 'blank',
        }),
      }),
    ).pipe(Effect.flip);
    expect(inflated.status).toBe(422);

    const unknownTemplate = yield* run((bff) =>
      bff.create({
        headers,
        idempotencyKey: 'key-4',
        payload: decode(CreateAccessRolePayloadSchema, {
          catalogSnapshotId: CATALOG,
          cells: [],
          name: 'Kontrolor',
          scope: { kind: 'tenant' },
          templateKey: 'does-not-exist',
        }),
      }),
    ).pipe(Effect.flip);
    expect(unknownTemplate.status).toBe(422);

    const movedRelease = yield* run((bff) =>
      bff.create({
        headers,
        idempotencyKey: 'key-5',
        payload: decode(CreateAccessRolePayloadSchema, {
          catalogSnapshotId: OTHER_ROLE,
          cells: [],
          name: 'Kontrolor',
          scope: { kind: 'tenant' },
          templateKey: 'blank',
        }),
      }),
    ).pipe(Effect.flip);
    expect(movedRelease.status).toBe(409);

    expect(recorded.creates.length).toBe(1);
  }),
);

it.effect('maps every Core refusal onto the one status a client can act on', () =>
  Effect.sync(() => {
    expect(accessRolesFailureProblem({ code: 'access_changes_authority_missing', reason: 'x' }).status).toBe(403);
    expect(accessRolesFailureProblem({ code: 'access_changes_agent_cannot_decide', reason: 'x' }).status).toBe(403);
    expect(accessRolesFailureProblem({ code: 'access_changes_preview_stale', reason: 'x' }).status).toBe(409);
    expect(accessRolesFailureProblem({ code: 'access_changes_revision_stale', reason: 'x' }).status).toBe(409);
    expect(accessRolesFailureProblem({ code: 'access_changes_record_conflict', reason: 'x' }).status).toBe(409);
    expect(accessRolesFailureProblem({ code: 'access_changes_store_unavailable', reason: 'x' }).status).toBe(503);
    // The role revision is recorded before it is projected: a projection that did not complete is a saved change.
    expect(accessRolesFailureProblem({ code: 'access_projection_write_unavailable', reason: 'x' })).toEqual(
      accessAdminSavedPendingProblem(),
    );
    expect(accessRolesFailureProblem({ code: 'access_changes_capability_not_configurable', reason: 'x' }).status).toBe(
      422,
    );
    expect(
      accessRolesFailureProblem({ code: 'access_changes_sensitive_requires_individual_decision', reason: 'x' }).status,
    ).toBe(422);
  }),
);

it.effect('declares one tenant-context administration capability per operation, never a record selector', () =>
  Effect.sync(() => {
    const declarations = Object.values(accessRolesDeclarations);
    expect(declarations.length).toBe(6);
    expect(new Set(declarations.map(({ key }) => key)).size).toBe(6);
    for (const declaration of declarations) {
      expect(declaration.kind).toBe('admin');
      expect(declaration.selectors).toEqual([]);
      expect(declaration.modes).toEqual(['run']);
      // O89: the declarations of an entrypoint in the Shell module live in the shell-super-app
      // namespace, so the catalog's O27 prefix rule and the module key agree.
      expect(declaration.key.startsWith('shell-super-app.access-')).toBe(true);
    }
    expect(Object.keys(accessRolesEntrypoints).length).toBe(6);
    for (const entrypoint of Object.values(accessRolesEntrypoints)) {
      expect(entrypoint.moduleKey).toBe('shell-super-app');
      expect(entrypoint.entrypointKey.startsWith('shell-super-app.access-')).toBe(true);
    }
    expect(accessRolesDeclarations.save.risk).toBe('critical');
    expect(accessRolesDeclarations.list.risk).toBe('sensitive');
  }),
);
