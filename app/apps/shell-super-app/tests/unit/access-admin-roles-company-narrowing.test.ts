import type { LegalEntityScope, OperationalScope } from '@app/core-runtime';
import {
  AccessChangesStore,
  AccessScopeIdSchema,
  AssignmentSchema,
  CatalogSnapshotEntrySchema,
  CatalogSnapshotSchema,
  CellSchema,
  PrincipalIdSchema,
  RoleRevisionSchema,
  RoleSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/changes/role-revision';
import type {
  AccessChangesState,
  AccessChangesStoreService,
  Assignment,
  CatalogSnapshotEntry,
  Cell,
  Role,
  RoleRevision,
} from '@app/core-runtime/access/changes/role-revision';
import type { AccessDecision } from '@app/core-runtime/access/decision/contract';
import type { AccessDecisionService, GateInput } from '@app/core-runtime/access/enforcement';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { TenantIntentLoaderService } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { TenantIntentLoader } from '@app/core-runtime/access/intent/tenant-intent-loader';
import type { AccessProjectionWriterService } from '@app/core-runtime/access/intent/projection-writer';
import { AccessProjectionWriter } from '@app/core-runtime/access/intent/projection-writer';
import { DateTime, Effect, Layer, Option, Result, Schema } from 'effect';

import { expect, it } from 'effect-rstest';

import type { AccessAdminProblem } from '../../shared/access-admin-api.ts';
import {
  AccessPageSchema,
  AccessRoleEditPayloadSchema,
  CreateAccessRolePayloadSchema,
  GetAccessRolePayloadSchema,
} from '../../shared/access-admin-api.ts';
import { AccessAdminClock } from '../../api/access-admin/clock.ts';
import type { AccessAdminRolesBffService } from '../../api/access-admin/roles.ts';
import { AccessAdminRolesBff, AccessAdminRolesBffLive, accessRolesDeclarations } from '../../api/access-admin/roles.ts';
import { AccessAdminSession, accessAdminAuthenticationRequiredProblem } from '../../api/access-admin/session.ts';

/*
 * O88 for ROLE READS: the Role editor's list, one role with its holders, and the pinned templates.
 *
 * A company administrator now enters the administration PAGES by the surface marker (C27), but no BFF
 * operation carries that marker. The BFF therefore narrows each read itself: the tenant context is
 * asked with the operation's own declaration, and each company the tenant holds a role in is asked in
 * that company's own `required` scope. Everything below is mock-bound: a scripted gate answers the
 * declaration keys, the store answers intent fixtures, and no database, SpiceDB or live engine takes
 * part. What is proved here is this module's own narrowing rules — which contexts it asks, in which
 * scope, what it does with each answer and what it hands back. It is NOT proof that `configureBasesOf`,
 * the engine's structural branch or PostgreSQL row security behave correctly; that proof belongs to
 * the Core suites and to the live database lane.
 */

const uuid = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const TENANT = uuid(1);
const TENANT_SCOPE = uuid(2);
const CATALOG = uuid(3);
const PERSON = uuid(4);
const COMPANY_A = uuid(10);
const COMPANY_B = uuid(11);
const A_SCOPE = uuid(12);
const B_SCOPE = uuid(13);

const TENANT_ROLE = uuid(20);
const A_ROLE = uuid(21);
const A_ROLE_SECOND = uuid(22);
const B_ROLE = uuid(23);
const UNKNOWN_ROLE = uuid(24);
const TENANT_REVISION = uuid(40);
const A_REVISION = uuid(41);
const A_REVISION_SECOND = uuid(42);
const B_REVISION = uuid(43);
const TENANT_HOLDER = uuid(50);
const A_HOLDER = uuid(51);
const A_HOLDER_SECOND = uuid(52);
const B_HOLDER = uuid(53);

class FixtureInvalid extends Schema.TaggedError<FixtureInvalid>()('FixtureInvalid', { reason: Schema.String }) {}

const decode = <Value, Input>(schema: Schema.Decoder<Value>, input: Input): Value => {
  const decoded = Schema.decodeUnknownResult(schema)(input);
  if (Result.isFailure(decoded)) {
    throw new FixtureInvalid({ reason: `fixture is invalid: ${decoded.failure.message}` });
  }
  return decoded.success;
};

/** A stable order for the id lists a suite compares, so a test never depends on question order. */
const sorted = (values: readonly string[]): readonly string[] =>
  values.toSorted((left, right) => left.localeCompare(right));

/** The trusted tenant-context scope a role-administration request resolves: no selected company (O28). */
const scope: OperationalScope = Object.freeze({
  authBindingId: 'binding-1',
  authContextRef: 'session-1',
  authMethod: 'session' as const,
  correlationId: 'o88-role-reads',
  principalId: PrincipalIdSchema.make(PERSON),
  tenantId: TenantIdSchema.make(TENANT),
});

const instant = (hour: number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 3, hour)));
const NOW = instant(9);

const entry = (input: { readonly key: string; readonly kind?: string }): CatalogSnapshotEntry =>
  decode(CatalogSnapshotEntrySchema, {
    key: input.key,
    kind: input.kind ?? 'action',
    modes: ['run', 'propose', 'approve'],
    moduleKey: 'test',
    placement: { group: 'parties', level: 'basic' },
    risk: 'routine',
    selectors: ['all'],
  });

const READ = entry({ key: 'test.party.read' });
/** An entry the fixture roles never pin: a company administrator must not learn that it exists. */
const UNPINNED = entry({ key: 'test.tenant.configure', kind: 'admin' });

const catalog = decode(CatalogSnapshotSchema, {
  digest: 'a'.repeat(64),
  entries: [READ, UNPINNED],
  id: CATALOG,
  publishedAt: instant(1),
});

const cell = (capabilityKey: string): Cell =>
  decode(CellSchema, { capabilityKey, mode: 'run', selector: { _tag: 'all' } });

/** One role of the fixture: the company it lives in decides which scope may read it (O7). */
interface RoleFixture {
  readonly holder: string;
  readonly legalEntityId?: string;
  readonly name: string;
  readonly revisionId: string;
  readonly roleId: string;
}

const roleOf = (fixture: RoleFixture): Role => {
  const base = { createdAt: instant(0), createdBy: PERSON, id: fixture.roleId, name: fixture.name, tenantId: TENANT };
  return decode(
    RoleSchema,
    fixture.legalEntityId === undefined ? base : { ...base, legalEntityId: fixture.legalEntityId },
  );
};

const revisionOf = (fixture: RoleFixture): RoleRevision =>
  decode(RoleRevisionSchema, {
    catalogSnapshotId: CATALOG,
    cells: [cell('test.party.read')],
    createdAt: instant(0),
    createdBy: PERSON,
    id: fixture.revisionId,
    provenance: 'manual',
    revision: 1,
    roleId: fixture.roleId,
    tenantId: TENANT,
  });

/** The scope an assignment is made in: the company's own scope, or the tenant context (O7). */
const scopeIdOf = (fixture: RoleFixture): string => {
  if (fixture.legalEntityId === undefined) {
    return TENANT_SCOPE;
  }
  return fixture.legalEntityId === COMPANY_A ? A_SCOPE : B_SCOPE;
};

const assignmentOf = (fixture: RoleFixture): Assignment =>
  decode(AssignmentSchema, {
    assignedAt: instant(0),
    assignedBy: PERSON,
    holder: { _tag: 'Principal', principalId: fixture.holder },
    incarnationId: fixture.holder,
    roleId: fixture.roleId,
    roleRevisionId: fixture.revisionId,
    scopeId: scopeIdOf(fixture),
    status: 'active',
    tenantId: TENANT,
    validFrom: instant(0),
  });

const TENANT_ROLE_FIXTURE: RoleFixture = {
  holder: TENANT_HOLDER,
  name: 'Účetní',
  revisionId: TENANT_REVISION,
  roleId: TENANT_ROLE,
};
const A_ROLE_FIXTURE: RoleFixture = {
  holder: A_HOLDER,
  legalEntityId: COMPANY_A,
  name: 'Skladník A',
  revisionId: A_REVISION,
  roleId: A_ROLE,
};
const A_ROLE_SECOND_FIXTURE: RoleFixture = {
  holder: A_HOLDER_SECOND,
  legalEntityId: COMPANY_A,
  name: 'Vedoucí A',
  revisionId: A_REVISION_SECOND,
  roleId: A_ROLE_SECOND,
};
/** The role that must never appear for an administrator of company A, whatever page is asked for. */
const B_ROLE_FIXTURE: RoleFixture = {
  holder: B_HOLDER,
  legalEntityId: COMPANY_B,
  name: 'Aaa skladník B',
  revisionId: B_REVISION,
  roleId: B_ROLE,
};

const changesState = (fixtures: readonly RoleFixture[]): AccessChangesState => ({
  decisions: [],
  items: [],
  revisions: fixtures.map((fixture) => revisionOf(fixture)),
  roles: fixtures.map((fixture) => ({ revision: revisionOf(fixture), role: roleOf(fixture) })),
});

type ProjectionIntent = Effect.Success<ReturnType<TenantIntentLoaderService['loadProjection']>>;

/**
 * The tenant's intent as the loader answers it. The companies of the tenant are the two companies the
 * fixtures live in; this person's own memberships are deliberately NOT modelled here, because the read
 * narrowing must never derive authority from the loader (its `isLiveMember` also accepts the tenant
 * path) — only from the gate, which is why `loadConfigureBases` below is a defect if it is ever asked.
 */
const intent = (assignments: readonly Assignment[]): ProjectionIntent => ({
  catalogEntries: [READ],
  coverage: 'complete',
  legalEntities: [
    {
      accessAdmins: [],
      legalEntityId: COMPANY_A,
      members: [{ holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(PERSON) } }],
      suspended: [],
    },
    {
      accessAdmins: [],
      legalEntityId: COMPANY_B,
      members: [{ holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(PERSON) } }],
      suspended: [],
    },
  ],
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
        id: AccessScopeIdSchema.make(TENANT_SCOPE),
        scope: { _tag: 'TenantContext', tenantId: TenantIdSchema.make(TENANT) },
      },
    },
  ],
  suspended: [],
  tenantId: TenantIdSchema.make(TENANT),
});

/** What one scripted question may answer: exactly the outcomes the narrowing tells apart. */
const SCRIPT_ANSWERS = Schema.Literals(['allow', 'deny', 'owner', 'unavailable']);
type Answer = typeof SCRIPT_ANSWERS.Type;

/** The script: the tenant context by declaration key, and each company's own scope by declaration key. */
interface Script {
  readonly companies?: Readonly<Record<string, Readonly<Record<string, Answer>>>>;
  readonly tenant?: Readonly<Record<string, Answer>>;
}

/** One question the module asked, recorded so a suite can prove the scope it was asked in (O88). */
interface Asked {
  readonly key: string;
  readonly legalEntityId?: string;
  readonly legalEntityScope: LegalEntityScope;
  readonly principalId: string;
}

/** The same record of a question, built without a conditional spread. */
const askedOf = (input: GateInput): Asked => {
  const base = {
    key: input.carrier.accessDeclaration?.key ?? '',
    legalEntityScope: input.legalEntityScope,
    principalId: input.scope.principalId,
  };
  const company = input.scope.legalEntityId;
  return company === undefined ? base : { ...base, legalEntityId: company };
};

const decisionOf = (answer: Answer): AccessDecision => {
  if (answer === 'unavailable') {
    return { evidence: [], outcome: 'UNAVAILABLE', reasons: [{ code: 'unavailable.intent' }], selectors: [] };
  }
  if (answer === 'deny') {
    return { evidence: [], outcome: 'DENIED', reasons: [{ code: 'deny.insufficient_grant' }], selectors: [] };
  }
  const allowed = { evidence: [], outcome: 'ALLOWED', reasons: [{ code: 'allow.granted' }], selectors: [] } as const;
  // `owner` is a tenant-context answer. Company admission still depends on that company's guards.
  return answer === 'owner'
    ? {
        ...allowed,
        structuralEvidence: { basis: 'owner', scopeId: AccessScopeIdSchema.make(TENANT_SCOPE) },
      }
    : allowed;
};

/**
 * The gate a suite provides: it decides nothing and proves nothing, it answers the declaration keys
 * the suite scripted for the scope it was asked in. Two seam rules are reproduced so a suite can never
 * script an answer the live gate would not give: a `required` question without a company is refused,
 * and a declaration the script does not name is denied (O62, O88).
 */
const gateOf = (script: Script) => {
  const asked: Asked[] = [];
  const answerFor = (input: GateInput): Answer => {
    const key = input.carrier.accessDeclaration?.key;
    if (key === undefined || (input.legalEntityScope === 'required' && input.scope.legalEntityId === undefined)) {
      return 'deny';
    }
    const company = input.scope.legalEntityId;
    return company === undefined ? (script.tenant?.[key] ?? 'deny') : (script.companies?.[company]?.[key] ?? 'deny');
  };
  const service: AccessDecisionService = {
    decide: (input) => {
      asked.push(askedOf(input));
      return Effect.succeed(decisionOf(answerFor(input)));
    },
    // A Role read asks its tenant and company questions in one batch; each is answered as `decide` would.
    decideMany: (inputs) =>
      Effect.sync(() =>
        inputs.map((input) => {
          asked.push(askedOf(input));
          return decisionOf(answerFor(input));
        }),
      ),
    list: () => Effect.die(new FixtureInvalid({ reason: 'the Role editor reads no list predicate' })),
    listMany: () => Effect.die(new FixtureInvalid({ reason: 'the Role editor reads no list predicate' })),
    selectableLegalEntities: () => Effect.succeed([]),
  };
  return { asked, service };
};

const unusedCall = () => Effect.die(new FixtureInvalid({ reason: 'this suite never calls this method' }));

const authenticationRequired = (): AccessAdminProblem => accessAdminAuthenticationRequiredProblem();

interface FixtureInput {
  readonly fixtures?: readonly RoleFixture[];
  readonly script?: Script;
  readonly session?: 'tenant' | 'anonymous';
}

const fixture = (input: FixtureInput = {}) => {
  const fixtures = input.fixtures ?? [TENANT_ROLE_FIXTURE, A_ROLE_FIXTURE, A_ROLE_SECOND_FIXTURE, B_ROLE_FIXTURE];
  const assignments = fixtures.map((one) => assignmentOf(one));

  const store: AccessChangesStoreService = {
    loadPublishedCatalog: () => Effect.succeed(Option.some(catalog)),
    loadTenantChanges: () => Effect.succeed(changesState(fixtures)),
    publishCatalog: unusedCall,
    recordAdoption: unusedCall,
    recordChangeItems: unusedCall,
    recordDecline: unusedCall,
    recordRole: unusedCall,
    recordRoleRevision: unusedCall,
    recordUndo: unusedCall,
  };

  const loader: TenantIntentLoaderService = {
    loadAuthorityCells: () => Effect.succeed([]),
    loadAuthorityCellsMany: (_scope, queries) => Effect.succeed(queries.map(() => [])),
    // One fixture tenant: every company a request names is its own.
    loadCompanyOwnership: () => Effect.succeed(true),
    // Authority comes from the gate, never from the loader's membership reader (O88).
    loadConfigureBases: unusedCall,
    loadConnection: () => Effect.succeed(Option.none()),
    loadProjection: () => Effect.succeed(intent(assignments)),
    loadScope: () => Effect.succeed(Option.none()),
    loadTeamIds: () => Effect.succeed([]),
    loadTenantContextScopeId: () => Effect.succeed(Option.none()),
  };

  const writer: AccessProjectionWriterService = {
    reconcileTenant: () => Effect.die(new FixtureInvalid({ reason: 'these are reads; nothing is written' })),
  };

  const gate = gateOf(input.script ?? {});
  const session = input.session === 'anonymous' ? Effect.fail(authenticationRequired()) : Effect.succeed(scope);

  const runtime = Layer.mergeAll(
    Layer.succeed(AccessAdminSession, { requireTenantContext: () => session }),
    Layer.succeed(AccessDecisionGate, gate.service),
    Layer.succeed(AccessChangesStore, store),
    Layer.succeed(TenantIntentLoader, loader),
    Layer.succeed(AccessProjectionWriter, writer),
    Layer.succeed(AccessAdminClock, { now: Effect.succeed(NOW) }),
  );
  const bff: Effect.Effect<AccessAdminRolesBffService> = AccessAdminRolesBff.pipe(
    Effect.provide(AccessAdminRolesBffLive.pipe(Layer.provide(runtime))),
  );
  const run = <Value, Failure>(effect: (service: AccessAdminRolesBffService) => Effect.Effect<Value, Failure>) =>
    bff.pipe(Effect.flatMap((service) => effect(service)));
  return { asked: gate.asked, run };
};

const headers = new Headers({ 'idempotency-key': 'key-1' });

const listPayload = (input: { readonly cursor?: string; readonly limit?: number } = {}) =>
  decode(AccessPageSchema, input.cursor === undefined ? { limit: input.limit ?? 10 } : { ...input });

const detailPayload = (roleId: string) => decode(GetAccessRolePayloadSchema, { roleId });
/** A preview that names a revision the caller cannot know, so no stale-revision answer may leak. */
const previewPayload = (roleId: string) =>
  decode(AccessRoleEditPayloadSchema, {
    catalogSnapshotId: CATALOG,
    cells: [],
    expectedRoleRevisionId: uuid(99),
    roleId,
  });

const templatesPayload = () => decode(AccessPageSchema, { limit: 50 });

/** A new, empty role in one company, from one template the caller names. */
const createPayload = (legalEntityId: string, templateKey: string) =>
  decode(CreateAccessRolePayloadSchema, {
    catalogSnapshotId: CATALOG,
    cells: [],
    name: 'Nová role',
    scope: { kind: 'company', legalEntityId },
    templateKey,
  });

const listKeys = (response: { readonly items: readonly { readonly id: string }[] }) =>
  response.items.map(({ id }) => id);

const companyQuestionsOf = (asked: readonly Asked[]) =>
  asked.filter(({ legalEntityScope }) => legalEntityScope === 'required');

const tenantQuestionsOf = (asked: readonly Asked[]) =>
  asked.filter(({ legalEntityScope }) => legalEntityScope === 'optional');

/** The three read declarations of the editor, so a suite scripts exactly the operation it exercises. */
const LIST = accessRolesDeclarations.list.key;
const DETAIL = accessRolesDeclarations.detail.key;
const PREVIEW = accessRolesDeclarations.preview.key;
const TEMPLATES = accessRolesDeclarations.templates.key;
const CREATE = accessRolesDeclarations.create.key;
const SAVE = accessRolesDeclarations.save.key;

it.effect('shows the owner each company admitted by its own gate decision', () =>
  Effect.gen(function* ownerReadsEveryCompany() {
    const { asked, run } = fixture({
      script: {
        companies: {
          [COMPANY_A]: { [DETAIL]: 'allow', [LIST]: 'allow', [TEMPLATES]: 'allow' },
          [COMPANY_B]: { [DETAIL]: 'allow', [LIST]: 'allow', [TEMPLATES]: 'allow' },
        },
        tenant: { [DETAIL]: 'owner', [LIST]: 'owner', [TEMPLATES]: 'owner' },
      },
    });
    const listed = yield* run((bff) => bff.list(headers, listPayload()));
    expect(sorted(listKeys(listed))).toEqual(sorted([TENANT_ROLE, A_ROLE, A_ROLE_SECOND, B_ROLE]));
    // Even an owner must pass the company's guard; ownership cannot mask a company suspension.
    expect(asked.length).toBe(3);
    expect(asked[0]?.legalEntityScope).toBe('optional');
    expect(asked[0]?.legalEntityId).toBeUndefined();

    const companyRole = yield* run((bff) => bff.detail(headers, detailPayload(B_ROLE)));
    expect(companyRole.role.id).toBe(B_ROLE);
    expect(companyRole.holderCount).toBe(1);

    // The whole release belongs to a tenant-wide reader, and every role is a copy template.
    const templates = yield* run((bff) => bff.templates(headers, templatesPayload()));
    expect(templates.entries.map(({ capabilityKey }) => capabilityKey)).toEqual([READ.key, UNPINNED.key]);
    expect(templates.templates.map(({ source }) => source)).toContain('catalog_full_access');
  }),
);

it.effect('does not let tenant ownership bypass a company denial or unavailable authority', () =>
  Effect.gen(function* ownerStillNeedsCompanyAdmission() {
    const { run } = fixture({
      script: {
        companies: {
          [COMPANY_A]: { [DETAIL]: 'allow', [LIST]: 'allow' },
          [COMPANY_B]: { [DETAIL]: 'deny', [LIST]: 'deny' },
        },
        tenant: { [DETAIL]: 'owner', [LIST]: 'owner' },
      },
    });
    const listed = yield* run((bff) => bff.list(headers, listPayload()));
    expect(sorted(listKeys(listed))).toEqual(sorted([TENANT_ROLE, A_ROLE, A_ROLE_SECOND]));
    const refusal = yield* run((bff) => bff.detail(headers, detailPayload(B_ROLE))).pipe(Effect.flip);
    expect(refusal.status).toBe(403);

    const unreadable = fixture({
      script: {
        companies: { [COMPANY_A]: { [LIST]: 'allow' }, [COMPANY_B]: { [LIST]: 'unavailable' } },
        tenant: { [LIST]: 'owner' },
      },
    });
    const unavailable = yield* unreadable.run((bff) => bff.list(headers, listPayload())).pipe(Effect.flip);
    expect(unavailable.status).toBe(503);
  }),
);

it.effect('shows a company administrator only their own company, in that company’s required scope', () =>
  Effect.gen(function* companyAdminSeesOneCompany() {
    const { asked, run } = fixture({
      script: { companies: { [COMPANY_A]: { [DETAIL]: 'allow', [LIST]: 'allow', [TEMPLATES]: 'allow' } } },
    });
    const listed = yield* run((bff) => bff.list(headers, listPayload()));
    expect(sorted(listKeys(listed))).toEqual(sorted([A_ROLE, A_ROLE_SECOND]));
    expect(listed.nextCursor).toBeNull();

    // Every company that holds a role was asked in its own scope with this operation's declaration.
    const companyQuestions = companyQuestionsOf(asked);
    expect(
      sorted(companyQuestions.flatMap((one) => (one.legalEntityId === undefined ? [] : [one.legalEntityId]))),
    ).toEqual(sorted([COMPANY_A, COMPANY_B]));
    expect(sorted(companyQuestions.map(({ key }) => key))).toEqual(sorted([LIST, LIST]));
    expect(companyQuestions.every(({ principalId }) => principalId === PERSON)).toBe(true);
    // The tenant context is asked too, so tenant-context roles stay a separate answer.
    expect(tenantQuestionsOf(asked).length).toBe(1);

    const own = yield* run((bff) => bff.detail(headers, detailPayload(A_ROLE)));
    expect(own.role.id).toBe(A_ROLE);
    expect(own.holders.map(({ assignmentIncarnationId }) => assignmentIncarnationId)).toEqual([A_HOLDER]);

    // List/detail parity: exactly the listed roles answer a detail, and nothing else does.
    for (const roleId of [A_ROLE, A_ROLE_SECOND]) {
      const one = yield* run((bff) => bff.detail(headers, detailPayload(roleId)));
      expect(one.role.id).toBe(roleId);
    }
  }),
);

it.effect('returns an empty page for an authorized company with no roles yet', () =>
  Effect.gen(function* authorizedEmptyCompany() {
    const { asked, run } = fixture({
      fixtures: [TENANT_ROLE_FIXTURE, B_ROLE_FIXTURE],
      script: { companies: { [COMPANY_A]: { [LIST]: 'allow' } } },
    });
    const listed = yield* run((bff) => bff.list(headers, listPayload()));
    expect(listed.items).toEqual([]);
    expect(listed.nextCursor).toBeNull();
    expect(companyQuestionsOf(asked).some(({ legalEntityId }) => legalEntityId === COMPANY_A)).toBe(true);
  }),
);

it.effect('refuses another company’s role and a tenant role exactly like a role that does not exist', () =>
  Effect.gen(function* otherCompanyIsIndistinguishable() {
    const { run } = fixture({ script: { companies: { [COMPANY_A]: { [DETAIL]: 'allow' } } } });
    const otherCompany = yield* run((bff) => bff.detail(headers, detailPayload(B_ROLE))).pipe(Effect.flip);
    const tenantRole = yield* run((bff) => bff.detail(headers, detailPayload(TENANT_ROLE))).pipe(Effect.flip);
    const missing = yield* run((bff) => bff.detail(headers, detailPayload(UNKNOWN_ROLE))).pipe(Effect.flip);

    for (const refusal of [otherCompany, tenantRole, missing]) {
      expect(refusal.status).toBe(403);
    }
    // No enumeration: an existing role outside the caller's authority reads exactly like no role.
    expect(otherCompany.detail).toBe(missing.detail);
    expect(tenantRole.detail).toBe(missing.detail);
  }),
);

it.effect('refuses a preview of another company’s role before planning, like a role that does not exist', () =>
  Effect.gen(function* previewIsBoundToTheRoleCompany() {
    // A tenant-context manager whose envelope holds the preview key, but not company B's authority.
    const { run } = fixture({
      script: {
        companies: { [COMPANY_A]: { [PREVIEW]: 'allow' }, [COMPANY_B]: { [PREVIEW]: 'deny' } },
        tenant: { [PREVIEW]: 'allow' },
      },
    });
    const otherCompany = yield* run((bff) => bff.preview(headers, previewPayload(B_ROLE))).pipe(Effect.flip);
    const missing = yield* run((bff) => bff.preview(headers, previewPayload(UNKNOWN_ROLE))).pipe(Effect.flip);
    expect(otherCompany.status).toBe(403);
    // No revision id, cell or holder of the hidden role reaches the caller.
    expect(otherCompany.detail).toBe(missing.detail);
  }),
);

it.effect(
  'refuses creating a role in another company, or copying its role, like a company or template that does not exist',
  () =>
    Effect.gen(function* createIsBoundToTheTargetCompany() {
      // A tenant-context manager whose envelope holds the create key, but not company B's authority.
      const { run } = fixture({
        script: {
          companies: { [COMPANY_A]: { [CREATE]: 'allow' }, [COMPANY_B]: { [CREATE]: 'deny' } },
          tenant: { [CREATE]: 'allow' },
        },
      });
      const create = (legalEntityId: string, templateKey: string) =>
        run((bff) =>
          bff.create({ headers, idempotencyKey: 'key-1', payload: createPayload(legalEntityId, templateKey) }),
        );

      const otherCompany = yield* create(COMPANY_B, 'blank').pipe(Effect.flip);
      const unknownCompany = yield* create(uuid(98), 'blank').pipe(Effect.flip);
      expect(otherCompany.status).toBe(403);
      expect(otherCompany.detail).toBe(unknownCompany.detail);

      // A copy of B's role into the manager's own company names B's exact cells, so it reads like no template.
      const copiedFromB = yield* create(COMPANY_A, `copy:${B_ROLE}`).pipe(Effect.flip);
      const copiedFromNobody = yield* create(COMPANY_A, `copy:${UNKNOWN_ROLE}`).pipe(Effect.flip);
      expect(copiedFromB.status).toBe(403);
      expect(copiedFromB.detail).toBe(copiedFromNobody.detail);
    }),
);

it.effect('cuts the page and counts holders only after the narrowing, so a hidden role shifts no cursor', () =>
  Effect.gen(function* narrowsBeforePaging() {
    const { run } = fixture({
      fixtures: [B_ROLE_FIXTURE, A_ROLE_FIXTURE, A_ROLE_SECOND_FIXTURE],
      script: { companies: { [COMPANY_A]: { [DETAIL]: 'allow', [LIST]: 'allow' } } },
    });
    // B's role sorts FIRST by name, so an un-narrowed page of two would have carried it.
    const first = yield* run((bff) => bff.list(headers, listPayload({ limit: 2 })));
    expect(sorted(listKeys(first))).toEqual(sorted([A_ROLE, A_ROLE_SECOND]));
    expect(first.nextCursor).toBeNull();
    expect(first.items.every(({ holderCount }) => holderCount === 1)).toBe(true);
    expect(first.items.some(({ name }) => name === B_ROLE_FIXTURE.name)).toBe(false);

    // One role per page: the cursor counts the narrowed list, never the tenant's whole role set.
    const page = yield* run((bff) => bff.list(headers, listPayload({ limit: 1 })));
    expect(page.items.length).toBe(1);
    expect(page.nextCursor).toBe('1');
    const next = yield* run((bff) => bff.list(headers, listPayload({ cursor: '1', limit: 1 })));
    expect(next.items.length).toBe(1);
    expect(next.nextCursor).toBeNull();
    expect(sorted([...listKeys(page), ...listKeys(next)])).toEqual(sorted([A_ROLE, A_ROLE_SECOND]));
  }),
);

it.effect('answers save and create availability each by its own declaration', () =>
  Effect.gen(function* separateWriteAvailability() {
    // A manager who may edit existing roles but not create new ones keeps a working editor.
    const { run } = fixture({ script: { tenant: { [SAVE]: 'allow', [TEMPLATES]: 'owner' } } });
    const response = yield* run((bff) => bff.templates(headers, templatesPayload()));
    expect(response.saveAvailable).toBe(true);
    expect(response.saveUnavailableReason).toBeUndefined();
    expect(response.createAvailable).toBe(false);
    expect(response.createUnavailableReason).toBe('configure_forbidden');
  }),
);

it.effect('offers only the readable roles as copy templates, and keeps the writes closed (O88)', () =>
  Effect.gen(function* narrowsTemplates() {
    const { run } = fixture({
      script: { companies: { [COMPANY_A]: { [DETAIL]: 'allow', [LIST]: 'allow', [TEMPLATES]: 'allow' } } },
    });
    const response = yield* run((bff) => bff.templates(headers, templatesPayload()));
    const sources = response.templates.map(({ source }) => source);
    expect(sources).toContain('blank');
    // "Plný přístup" is every capability of the release, so a company's administrator is not offered it.
    expect(sources).not.toContain('catalog_full_access');
    // The release reaches them only as far as their own roles pin it: the unpinned entry stays hidden.
    expect(response.catalogSnapshotId).toBe(CATALOG);
    expect(response.entries.map(({ capabilityKey }) => capabilityKey)).toEqual([READ.key]);
    const copies = response.templates.flatMap((one) => (one.source === 'copy_role' ? [one] : []));
    expect(sorted(copies.flatMap((one) => (one.sourceRoleId === undefined ? [] : [one.sourceRoleId])))).toEqual(
      sorted([A_ROLE, A_ROLE_SECOND]),
    );
    // Another company's role name never reaches the editor, not even through a copy template.
    expect(response.templates.some(({ name }) => name === B_ROLE_FIXTURE.name)).toBe(false);
    // Writes are still the tenant-context question: a company administrator reads and cannot edit.
    expect(response.saveAvailable).toBe(false);
    expect(response.saveUnavailableReason).toBe('configure_forbidden');
    expect(response.createAvailable).toBe(false);
  }),
);

it.effect('asks each operation its own declaration, so a bounded delegation reaches only what it names', () =>
  Effect.gen(function* perOperationDeclaration() {
    // A delegated manager whose envelope names the list and nothing else of this editor.
    const { run } = fixture({ script: { companies: { [COMPANY_A]: { [LIST]: 'allow' } } } });
    const listed = yield* run((bff) => bff.list(headers, listPayload()));
    expect(sorted(listKeys(listed))).toEqual(sorted([A_ROLE, A_ROLE_SECOND]));

    const detail = yield* run((bff) => bff.detail(headers, detailPayload(A_ROLE))).pipe(Effect.flip);
    expect(detail.status).toBe(403);
    const templates = yield* run((bff) => bff.templates(headers, templatesPayload())).pipe(Effect.flip);
    expect(templates.status).toBe(403);
  }),
);

it.effect('refuses a caller whose authority covers no role at all, and never answers an empty page', () =>
  Effect.gen(function* refusesWithoutAuthority() {
    const { run } = fixture();
    const listed = yield* run((bff) => bff.list(headers, listPayload())).pipe(Effect.flip);
    expect(listed.status).toBe(403);
    const detail = yield* run((bff) => bff.detail(headers, detailPayload(A_ROLE))).pipe(Effect.flip);
    expect(detail.status).toBe(403);
    const templates = yield* run((bff) => bff.templates(headers, templatesPayload())).pipe(Effect.flip);
    expect(templates.status).toBe(403);

    const anonymous = yield* fixture({ session: 'anonymous' })
      .run((bff) => bff.list(headers, listPayload()))
      .pipe(Effect.flip);
    expect(anonymous.status).toBe(401);
  }),
);

it.effect('answers 503 — never a denial or a shorter list — when a required authority read is unavailable', () =>
  Effect.gen(function* unavailableStaysRetryable() {
    const tenantUnavailable = yield* fixture({ script: { tenant: { [LIST]: 'unavailable' } } })
      .run((bff) => bff.list(headers, listPayload()))
      .pipe(Effect.flip);
    expect(tenantUnavailable.status).toBe(503);

    // The company question is the one that fails: the read must not silently drop that company.
    const companyUnavailable = yield* fixture({
      script: { companies: { [COMPANY_A]: { [LIST]: 'unavailable' }, [COMPANY_B]: { [LIST]: 'allow' } } },
    })
      .run((bff) => bff.list(headers, listPayload()))
      .pipe(Effect.flip);
    expect(companyUnavailable.status).toBe(503);

    const detailUnavailable = yield* fixture({ script: { tenant: { [DETAIL]: 'unavailable' } } })
      .run((bff) => bff.detail(headers, detailPayload(A_ROLE)))
      .pipe(Effect.flip);
    expect(detailUnavailable.status).toBe(503);

    const templatesUnavailable = yield* fixture({ script: { tenant: { [TEMPLATES]: 'unavailable' } } })
      .run((bff) => bff.templates(headers, templatesPayload()))
      .pipe(Effect.flip);
    expect(templatesUnavailable.status).toBe(503);
  }),
);

it.effect('cannot be widened by a browser that names a company the wire contract does not carry', () =>
  Effect.gen(function* forgedCompanyIsIgnored() {
    const forged = decode(AccessPageSchema, {
      legalEntityId: COMPANY_B,
      limit: 10,
      scope: { kind: 'company', legalEntityId: COMPANY_B },
    });
    // The payload has no company field at all, so a browser cannot even express the choice.
    expect('scope' in forged).toBe(false);
    expect('legalEntityId' in forged).toBe(false);

    const { asked, run } = fixture({ script: { companies: { [COMPANY_A]: { [LIST]: 'allow' } } } });
    const listed = yield* run((bff) => bff.list(headers, forged));
    expect(sorted(listKeys(listed))).toEqual(sorted([A_ROLE, A_ROLE_SECOND]));
    // The companies asked about are the tenant's own, never a value a caller supplied.
    expect(
      sorted(companyQuestionsOf(asked).flatMap((one) => (one.legalEntityId === undefined ? [] : [one.legalEntityId]))),
    ).toEqual(sorted([COMPANY_A, COMPANY_B]));
  }),
);
