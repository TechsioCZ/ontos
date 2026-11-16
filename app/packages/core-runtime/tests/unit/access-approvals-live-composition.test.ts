import { NodeCrypto } from '@effect/platform-node';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { Cause, Context, Crypto, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import type { AccessChangesStoreService } from '../../src/access/changes/persistence/store.ts';
import { storeUnavailable } from '../../src/access/changes/persistence/errors/index.ts';
import type { AuthorityCell } from '../../src/access/decision/authority.ts';
import type { AccessScopeId, PrincipalId, TenantId } from '../../src/access/ids.ts';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CatalogDigestSchema,
  CatalogSnapshotIdSchema,
  GrantIncarnationIdSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  RecordKeySchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { AccessIntentDatabase, AccessTransactions } from '../../src/access/intent/persistence.ts';
import { callerTransactions, requestTransactions } from '../../src/access/intent/persistence.ts';
import { intentUnavailable } from '../../src/access/intent/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { administersScope } from '../../src/access/approvals/live-administration.ts';
import type {
  LiveApprovalIntentReads,
  LiveApprovalRecords,
  LiveApprovalServices,
} from '../../src/access/approvals/live-composition.ts';
import { liveApprovalsPorts } from '../../src/access/approvals/live-composition.ts';
import type { LiveMembershipFacts, LiveMembershipRow, ScopeRow } from '../../src/access/approvals/live-authority.ts';
import {
  holdsMembershipPath,
  liveWitnessFacts,
  localReachOf,
  lostWitnessFacts,
  membershipFactsOf,
  membershipPathOf,
  pinnedRevisionByRole,
} from '../../src/access/approvals/live-authority.ts';
import { ApprovalStorageUnavailableError } from '../../src/access/approvals/errors.ts';
import type { ApprovalsPorts } from '../../src/access/approvals/service.ts';
import { livePublishedCatalog, publishedCapabilityOf } from '../../src/access/approvals/live-catalog.ts';
import type { WitnessFacts } from '../../src/access/approvals/execution.ts';
import type { AuthorityWitness, CatalogSnapshot, CatalogSnapshotEntry, Holder } from '../../src/access/model.ts';

/*
 * The pure facts the live approvals composition decides on, without a database: how a published
 * release entry becomes the capability the policy binds, which membership path one scope needs, what
 * the membership rows state, when a configure basis administers an exact scope, and what the verdict
 * receives for a live cell and for a witness no live cell proves.
 *
 * The database-backed halves of the same adapters (live cells, role-binding revisions, the owner's
 * record projection and the failure taxonomy against a real PostgreSQL) are proved in
 * `tests/integration/access-approvals-live-composition.test.ts`.
 */

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const COMPANY = LegalEntityIdSchema.make(uid(2));
const COMPANY_SCOPE: AccessScopeId = AccessScopeIdSchema.make(uid(3));
const TENANT_SCOPE: AccessScopeId = AccessScopeIdSchema.make(uid(4));
const OTHER_SCOPE: AccessScopeId = AccessScopeIdSchema.make(uid(5));
const JANA = PrincipalIdSchema.make(uid(6));
const EVA = PrincipalIdSchema.make(uid(7));
const ROLE = RoleIdSchema.make(uid(8));
const REVISION = RoleRevisionIdSchema.make(uid(9));
const ASSIGNMENT = AssignmentIncarnationIdSchema.make(uid(10));
const GRANT = GrantIncarnationIdSchema.make(uid(11));
const VOID = CapabilityKeySchema.make('finance.invoice.void');
const MODULE = ModuleKeySchema.make('finance');
const RECORD = RecordKeySchema.make('invoice-1');
const AT = DateTime.toDateUtc(DateTime.makeUnsafe('2099-01-01T00:00:00.000Z'));

const holder = (principalId: typeof JANA): Holder => ({ _tag: 'Principal', principalId });

const scopeRows: readonly ScopeRow[] = [
  { legalEntityId: null, scopeId: TENANT_SCOPE },
  { legalEntityId: COMPANY, scopeId: COMPANY_SCOPE },
  { legalEntityId: null, scopeId: OTHER_SCOPE },
];

const membershipRow = (input: {
  readonly agentId?: string;
  readonly kind: 'access_admin' | 'member' | 'owner';
  readonly principalId?: string;
  readonly scopeId: AccessScopeId;
  readonly status: 'active' | 'revoked' | 'suspended';
  readonly validFrom?: Date;
  readonly validUntil?: Date;
}): LiveMembershipRow => ({
  agentId: input.agentId ?? null,
  kind: input.kind,
  principalId: input.agentId === undefined ? (input.principalId ?? JANA) : null,
  scopeId: input.scopeId,
  status: input.status,
  validFrom: input.validFrom ?? AT,
  validUntil: input.validUntil ?? null,
});

/** The two memberships a company-scope command rests on (D6, M2). */
const companyMemberships: readonly LiveMembershipRow[] = [
  membershipRow({ kind: 'member', scopeId: TENANT_SCOPE, status: 'active' }),
  membershipRow({ kind: 'member', scopeId: COMPANY_SCOPE, status: 'active' }),
];
const tenantMembership = membershipRow({ kind: 'member', scopeId: TENANT_SCOPE, status: 'active' });
const companyMembership = membershipRow({ kind: 'member', scopeId: COMPANY_SCOPE, status: 'active' });

const factsOf = (rows: readonly LiveMembershipRow[], subject: Holder = holder(JANA)): LiveMembershipFacts =>
  membershipFactsOf({ at: AT, holder: subject, rows });

const adminBases = (deadline?: Date): readonly AccessConfigureBasis[] => [
  {
    _tag: 'ScopeAdmin',
    deadlines: deadline === undefined ? [] : [{ legalEntityId: COMPANY, until: deadline }],
    legalEntityIds: [COMPANY],
    tenantContext: false,
  },
];

const OWNER_BASES: readonly AccessConfigureBasis[] = [{ _tag: 'Owner' }];

const administers = (input: {
  readonly at?: Date;
  readonly bases: readonly AccessConfigureBasis[];
  readonly facts?: LiveMembershipFacts;
  readonly row?: ScopeRow;
  readonly tenantScopeIds?: readonly string[];
}) =>
  administersScope({
    at: input.at ?? AT,
    bases: input.bases,
    facts: input.facts ?? factsOf(companyMemberships),
    row: input.row ?? { legalEntityId: COMPANY, scopeId: COMPANY_SCOPE },
    tenantScopeIds: input.tenantScopeIds ?? [TENANT_SCOPE],
  });

const releaseEntry: CatalogSnapshotEntry = {
  key: VOID,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  moduleKey: MODULE,
  placement: { group: 'Invoices', level: 'extended' },
  risk: 'sensitive',
  selectors: ['all', 'assigned'],
};

const snapshotOf = (entries: readonly CatalogSnapshotEntry[]): CatalogSnapshot => ({
  digest: CatalogDigestSchema.make('a'.repeat(64)),
  entries,
  id: CatalogSnapshotIdSchema.make(uid(20)),
  publishedAt: AT,
});

const cell: AuthorityCell = {
  assignedAt: AT,
  assignedBy: EVA,
  assignmentIncarnationId: ASSIGNMENT,
  capabilityKey: VOID,
  deadline: DateTime.toDateUtc(DateTime.makeUnsafe('2099-02-01T00:00:00.000Z')),
  grantIncarnationId: GRANT,
  holder: holder(JANA),
  mode: 'approve',
  roleId: ROLE,
  roleRevisionId: REVISION,
  selector: { _tag: 'all' },
};

const witness: AuthorityWitness = {
  assignmentIncarnationId: ASSIGNMENT,
  capabilityKey: VOID,
  grantIncarnationId: GRANT,
  holderId: holder(JANA),
  mode: 'approve',
  purpose: 'approval',
  scopeId: COMPANY_SCOPE,
};

/** A release reader that answers one snapshot; the shipped port's shape, nothing more. */
const releasing =
  (snapshot: Option.Option<CatalogSnapshot>): AccessChangesStoreService['loadPublishedCatalog'] =>
  () =>
    Effect.succeed(snapshot);

it.effect('reads a published release entry as the capability the approval policy binds', () =>
  Effect.sync(() => {
    expect(publishedCapabilityOf(releaseEntry)).toStrictEqual({
      capabilityKey: VOID,
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      risk: 'sensitive',
      selectors: ['all', 'assigned'],
    });
    // An ephemeral proof is carried only when the release says so, never as a default.
    const ephemeral = publishedCapabilityOf({
      ...releaseEntry,
      ephemeral: true,
      key: CapabilityKeySchema.make('finance.invoice.peek'),
    });
    expect(ephemeral.ephemeral).toBe(true);
  }),
);

it.effect('answers the published capability and its module from the release, and nothing else', () =>
  Effect.gen(function* publishedCatalog() {
    const catalog = Option.some(snapshotOf([releaseEntry])).pipe(releasing, livePublishedCatalog);
    expect(Option.getOrThrow(yield* catalog.lookup(VOID)).capabilityKey).toBe(VOID);
    expect(Option.getOrThrow(yield* catalog.moduleKeyOf(VOID))).toBe(MODULE);
    const absent = CapabilityKeySchema.make('finance.invoice.unpublished');
    expect(Option.isNone(yield* catalog.lookup(absent))).toBe(true);
    expect(Option.isNone(yield* catalog.moduleKeyOf(absent))).toBe(true);
    // Nothing published is no catalog at all, which the policy refuses rather than assumes.
    const empty = Option.none<CatalogSnapshot>().pipe(releasing, livePublishedCatalog);
    expect(Option.isNone(yield* empty.lookup(VOID))).toBe(true);
  }),
);

it.effect('reports an unreadable release as retryable storage unavailability', () =>
  Effect.gen(function* unreadableRelease() {
    const catalog = livePublishedCatalog(() => Effect.fail(storeUnavailable('The release could not be read')));
    const failure = yield* Effect.flip(catalog.lookup(VOID));
    expect(Schema.is(ApprovalStorageUnavailableError)(failure)).toBe(true);
    expect(failure.reason).toContain('access_changes_store_unavailable');
  }),
);

it.effect('does not let tenant ownership override a company suspension or missing tenant path', () =>
  Effect.sync(() => {
    expect(administers({ bases: OWNER_BASES, facts: factsOf([tenantMembership]) })).toBe(true);
    expect(
      administers({
        bases: OWNER_BASES,
        facts: factsOf([
          tenantMembership,
          membershipRow({ kind: 'member', scopeId: COMPANY_SCOPE, status: 'suspended' }),
        ]),
      }),
    ).toBe(false);
    expect(administers({ bases: OWNER_BASES, tenantScopeIds: [] })).toBe(false);
  }),
);

it.effect('names the exact membership path one scope needs, never a wider or an empty one', () =>
  Effect.sync(() => {
    const companyScope: ScopeRow = { legalEntityId: COMPANY, scopeId: COMPANY_SCOPE };
    expect(Option.getOrThrow(membershipPathOf(scopeRows, TENANT_SCOPE)).requiredScopeIds).toStrictEqual([TENANT_SCOPE]);
    // A company command rests on the company's membership and the tenant context's (D6, M2).
    expect(Option.getOrThrow(membershipPathOf(scopeRows, COMPANY_SCOPE)).requiredScopeIds).toStrictEqual([
      COMPANY_SCOPE,
      TENANT_SCOPE,
    ]);
    // A scope this tenant does not own has no path at all; "unknown" is never "no membership needed".
    expect(Option.isNone(membershipPathOf(scopeRows, AccessScopeIdSchema.make(uid(99))))).toBe(true);
    // Without a tenant context there is no company path either.
    expect(Option.isNone(membershipPathOf([companyScope], COMPANY_SCOPE))).toBe(true);
  }),
);

it.effect('states membership and suspension from the rows, and never trusts one boolean for both scopes', () =>
  Effect.sync(() => {
    const both = factsOf(companyMemberships);
    expect(holdsMembershipPath(both, { requiredScopeIds: [COMPANY_SCOPE, TENANT_SCOPE] })).toBe(true);

    // A tenant-only member is no company member, so a company command is not that person's.
    const tenantOnly = factsOf([tenantMembership]);
    expect(holdsMembershipPath(tenantOnly, { requiredScopeIds: [COMPANY_SCOPE, TENANT_SCOPE] })).toBe(false);

    // A suspension on either path subtracts the whole path (D27).
    const suspended = factsOf([
      tenantMembership,
      membershipRow({ kind: 'member', scopeId: COMPANY_SCOPE, status: 'suspended' }),
    ]);
    expect(holdsMembershipPath(suspended, { requiredScopeIds: [COMPANY_SCOPE, TENANT_SCOPE] })).toBe(false);

    // A row that has not begun, and one that has ended, state nothing at all.
    const future = factsOf([
      tenantMembership,
      membershipRow({
        kind: 'member',
        scopeId: COMPANY_SCOPE,
        status: 'active',
        validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2099-06-01T00:00:00.000Z')),
      }),
    ]);
    expect(holdsMembershipPath(future, { requiredScopeIds: [COMPANY_SCOPE, TENANT_SCOPE] })).toBe(false);
    const ended = factsOf([
      tenantMembership,
      membershipRow({ kind: 'member', scopeId: COMPANY_SCOPE, status: 'active', validUntil: AT }),
    ]);
    expect(holdsMembershipPath(ended, { requiredScopeIds: [COMPANY_SCOPE, TENANT_SCOPE] })).toBe(false);

    // Another holder's rows are never read as this holder's.
    expect(holdsMembershipPath(factsOf(companyMemberships, holder(EVA)), { requiredScopeIds: [TENANT_SCOPE] })).toBe(
      false,
    );
    // Management facts are not membership: an access_admin row alone is no operational membership.
    const administrationOnly = factsOf([
      membershipRow({ kind: 'access_admin', scopeId: COMPANY_SCOPE, status: 'active' }),
    ]);
    expect(holdsMembershipPath(administrationOnly, { requiredScopeIds: [COMPANY_SCOPE] })).toBe(false);
  }),
);

it.effect('resolves a scope administrator from the configure basis AND the canonical membership path', () =>
  Effect.sync(() => {
    // A company access-admin decides with the company's own membership and the tenant context's.
    expect(administers({ bases: adminBases() })).toBe(true);
    // Without the company membership the same basis decides nothing.
    expect(administers({ bases: adminBases(), facts: factsOf([tenantMembership]) })).toBe(false);
    // A suspension on the company path subtracts it even though the basis is live.
    expect(
      administers({
        bases: adminBases(),
        facts: factsOf([
          tenantMembership,
          membershipRow({ kind: 'member', scopeId: COMPANY_SCOPE, status: 'suspended' }),
        ]),
      }),
    ).toBe(false);
    // The access-admin window itself ends: a deadline at this instant is no longer live.
    expect(administers({ bases: adminBases(AT) })).toBe(false);
    expect(
      administers({ bases: adminBases(DateTime.toDateUtc(DateTime.makeUnsafe('2099-03-01T00:00:00.000Z'))) }),
    ).toBe(true);
    // A basis naming another company never covers this scope.
    expect(
      administers({
        bases: [{ _tag: 'ScopeAdmin', legalEntityIds: [LegalEntityIdSchema.make(uid(30))], tenantContext: false }],
      }),
    ).toBe(false);
    // The tenant context accepts no company administrator (O81).
    expect(
      administers({
        bases: adminBases(),
        facts: factsOf([tenantMembership]),
        row: { legalEntityId: null, scopeId: TENANT_SCOPE },
      }),
    ).toBe(false);
    // A tenant owner inherits the scopes of that tenant from the tenant context: it needs the tenant
    // membership and no company one, and a suspension still subtracts it.
    expect(administers({ bases: OWNER_BASES, facts: factsOf([tenantMembership]) })).toBe(true);
    expect(
      administers({
        bases: OWNER_BASES,
        facts: factsOf([membershipRow({ kind: 'member', scopeId: TENANT_SCOPE, status: 'suspended' })]),
      }),
    ).toBe(false);
    expect(administers({ bases: OWNER_BASES, facts: factsOf([]) })).toBe(false);
    // A member with no management basis administers nothing.
    expect(administers({ bases: [] })).toBe(false);
    expect(companyMembership.kind).toBe('member');
  }),
);

it.effect('decides a selector reach locally only where the selector itself proves it', () =>
  Effect.sync(() => {
    expect(Option.getOrThrow(localReachOf({ _tag: 'all' }, RECORD))).toBe(true);
    expect(Option.getOrThrow(localReachOf({ _tag: 'targets', recordKeys: [RECORD] }, RECORD))).toBe(true);
    expect(
      Option.getOrThrow(localReachOf({ _tag: 'targets', recordKeys: [RecordKeySchema.make('invoice-2')] }, RECORD)),
    ).toBe(false);
    // A record-scoped selector needs the owner's projection, so it answers nothing on its own.
    expect(Option.isNone(localReachOf({ _tag: 'assigned' }, RECORD))).toBe(true);
    expect(Option.isNone(localReachOf({ _tag: 'entrusted' }, RECORD))).toBe(true);
    expect(Option.isNone(localReachOf({ _tag: 'team' }, RECORD))).toBe(true);
  }),
);

it.effect('states the exact facts of a live cell and a definite loss for a witness no cell proves', () =>
  Effect.sync(() => {
    const live = liveWitnessFacts({
      cell,
      grantRoleRevisionId: REVISION,
      reachesTarget: true,
      scopeId: COMPANY_SCOPE,
      witness,
    });
    expect(live.assignmentRoleRevisionId).toBe(REVISION);
    expect(live.assignmentScopeId).toBe(COMPANY_SCOPE);
    expect(live.assignmentState).toBe('live');
    expect(live.grantCell).toStrictEqual({ capabilityKey: VOID, mode: 'approve', selector: { _tag: 'all' } });
    expect(live.grantRoleRevisionId).toBe(REVISION);
    expect(live.grantScopeId).toBe(COMPANY_SCOPE);
    expect(live.grantState).toBe('live');
    expect(live.holderId).toStrictEqual(holder(JANA));

    // A role binding whose revision intent cannot prove leaves the fact unknown, never assumed equal.
    const unpinned = liveWitnessFacts({ cell, reachesTarget: null, scopeId: COMPANY_SCOPE, witness });
    expect(unpinned.grantRoleRevisionId).toBeNull();
    expect(unpinned.reachesTarget).toBeNull();

    const lost: WitnessFacts = lostWitnessFacts(witness);
    expect(lost).toStrictEqual({
      assignmentRoleRevisionId: null,
      assignmentScopeId: null,
      assignmentState: 'lost',
      grantCell: null,
      grantRoleRevisionId: null,
      grantScopeId: null,
      grantState: 'lost',
      holderId: null,
      reachesTarget: null,
      witness,
    });
  }),
);

/*
 * The transaction seam a mandate claim needs (O75). A claim decides inside the owner Action's
 * transaction, holding that transaction's proposal lock, so every authority fact it reads has to come
 * from THERE: a read through a second connection describes another instant, and on one connection
 * PostgreSQL refuses it outright. These checks prove the seam, its scope binding and its fail-closed
 * default without a database; the live read paths themselves are proved against PostgreSQL in
 * `tests/integration/access-approvals-live-composition.test.ts`.
 */

const TENANT = TenantIdSchema.make(uid(40));
const OTHER_TENANT = TenantIdSchema.make(uid(41));
const PROPOSAL = ProposalIdSchema.make(uid(42));

const scopeFor = (principalId: PrincipalId, tenantId: TenantId = TENANT): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authContextRef: `job:live-approvals:run:${principalId}`,
    authMethod: 'system',
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'live-approvals' })),
    Effect.orDie,
  );

/** What one tripwire reports: that a read reached a source of its own instead of the caller's. */
const tripped = (what: string): string => `${what} reached a transaction of its own`;

/** A transaction source that answers nothing and says so, so a check can see that a read was tried. */
const tripwired = (what: string): AccessTransactions => ({
  readIsolation: 'request-repeatable-read',
  scoped: () => Effect.die(new Error(tripped(what))),
  scopedRead: () => Effect.die(new Error(tripped(what))),
});

/** A statement the seam is never expected to send through the transaction it was handed. */
const unexpectedStatement = (what: string) => () => Effect.die(new Error(`the seam ran a ${what} of its own`));

const roleProbeSql = 'select current_user::text as role';
const installAndReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";
/** One transaction's scope statements: the connected role chooses the authority, then one install-and-read. */
const scopeStatements = [roleProbeSql, installAndReadScopeSql];

/**
 * A transaction that answers the operational scope installation and nothing else: the row it returns is
 * the scope the request installed, which is the only statement an access source issues before its body
 * (`installOperationalScope`: the connected role is probed, then one statement installs the session settings and reads
 * back the connected role).
 */
const seamTransaction = (scope: OperationalScope, statements: string[]): CoreTransaction =>
  Object.assign(Object.create(null), {
    delete: unexpectedStatement('delete'),
    execute: (statement: SQL) => {
      const query = new PgDialect().sqlToQuery(statement);
      statements.push(query.sql);
      if (query.sql === roleProbeSql) {
        return Effect.succeed([{ role: 'ontos_runtime' }]);
      }
      if (query.sql !== installAndReadScopeSql) {
        return Effect.die(new Error(`the seam ran an unexpected statement: ${query.sql}`));
      }
      expect(query.params).toEqual([scope.tenantId, scope.legalEntityId ?? '']);
      return Effect.succeed([
        { legal_entity_id: scope.legalEntityId ?? '', role: 'ontos_runtime', tenant_id: scope.tenantId },
      ]);
    },
    insert: unexpectedStatement('insert'),
    select: unexpectedStatement('select'),
    update: unexpectedStatement('update'),
  });

/**
 * A pool of one capability: it records the configuration of every transaction it is asked to open and
 * hands that body a transaction of its own, which is exactly what a request-scoped read does (O66).
 */
const recordingPool = (scope: OperationalScope) => {
  const opened: (PgTransactionConfig | undefined)[] = [];
  const statements: string[] = [];
  const transaction = seamTransaction(scope, statements);
  const database: AccessIntentDatabase = Object.assign(Object.create(null), {
    enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    executor: Object.assign(Object.create(null), {
      $client: { transactionService: Context.Service<unknown>('test/RecordingPoolTransaction') },
      transaction: <Value, Failure>(
        body: (openedTransaction: CoreTransaction) => Effect.Effect<Value, Failure>,
        config?: PgTransactionConfig,
      ) => {
        opened.push(config);
        return body(transaction);
      },
    }),
  });
  return { database, opened, statements, transaction };
};

const neverReadIntent: LiveApprovalIntentReads = {
  loadAuthorityCells: () => Effect.die(new Error(tripped('the live authority cells'))),
  loadConfigureBases: () => Effect.die(new Error(tripped('the configure bases'))),
  loadTeamIds: () => Effect.die(new Error(tripped('the team membership'))),
};

const DefectMessageSchema = Schema.Struct({ message: Schema.String });

/** Whether one exit is the named tripwire, which is how a check proves that a read was attempted. */
const reached = (exit: Exit.Exit<unknown, unknown>, what: string): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) =>
      Cause.isDieReason(reason) &&
      Schema.is(DefectMessageSchema)(reason.defect) &&
      reason.defect.message === tripped(what),
  );

const storageNamed = (name: string): Effect.Effect<never, ApprovalStorageUnavailableError> =>
  Effect.fail(new ApprovalStorageUnavailableError({ code: 'approval_storage_unavailable', reason: name }));

/** The records of one source, told apart by the reason each one answers with. */
const recordsNamed = (name: string): LiveApprovalRecords => ({
  recordsFor: () => ({
    create: () => storageNamed(name),
    listOpen: () => storageNamed(name),
    load: () => storageNamed(name),
    recordEnd: () => storageNamed(name),
    save: () => storageNamed(name),
  }),
});

/** The live services of one check, with a tripwire under every source it does not override. */
const liveServices = (crypto: Crypto.Crypto, overrides: Partial<LiveApprovalServices> = {}): LiveApprovalServices => {
  const services: LiveApprovalServices = {
    crypto,
    intent: neverReadIntent,
    join: () => services,
    loadRelease: () => Effect.succeedSome(snapshotOf([releaseEntry])),
    records: recordsNamed('the scope records'),
    transactions: tripwired('the live authority rows'),
    ...overrides,
  };
  return services;
};

/** The stable refusal code and reason of one failed call. */
const failureOf = <Value, Failure extends { readonly code: string; readonly reason?: string }>(
  effect: Effect.Effect<Value, Failure>,
) => Effect.flip(effect).pipe(Effect.map((failure) => ({ code: failure.code, reason: failure.reason ?? '' })));

/** Which records answered one proposal read, by the reason that records source answers with. */
const recordsSourceOf = (ports: ApprovalsPorts) =>
  failureOf(ports.store.load({ proposalId: PROPOSAL, scopeId: COMPANY_SCOPE, tenantId: TENANT })).pipe(
    Effect.map((failure) => failure.reason),
  );

it.layer(NodeCrypto.layer)('live approvals transaction binding', (suite) => {
  suite.effect('binds every live read to the request scope and refuses another tenant before reading', () =>
    Effect.gen(function* scopeBinding() {
      const crypto = yield* Crypto.Crypto;
      const jana = yield* scopeFor(JANA);
      const ports = liveApprovalsPorts(liveServices(crypto), jana);
      const ask = (tenantId: TenantId) =>
        ports.authority.inspect({
          expectedHolder: holder(JANA),
          scopeId: COMPANY_SCOPE,
          tenantId,
          witnesses: [witness],
        });

      // Another tenant is answered before a row is read: no tripwire fires on this path.
      const foreign = yield* failureOf(ask(OTHER_TENANT));
      expect(foreign.code).toBe('approval_authority_unavailable');
      expect(foreign.reason).toContain('request own tenant');
      const foreignAdmin = yield* failureOf(
        ports.administrators.isAdministrator({ principalId: JANA, scopeId: COMPANY_SCOPE, tenantId: OTHER_TENANT }),
      );
      expect(foreignAdmin.code).toBe('approval_authority_unavailable');
      expect(foreignAdmin.reason).toContain('request own tenant');

      // The control: the same question inside the request's own tenant does read a source the
      // composition was built with, so the refusals above are the scope binding and nothing else.
      expect(reached(yield* Effect.exit(ask(TENANT)), 'the live authority rows')).toBe(true);
      expect(
        reached(
          yield* Effect.exit(
            ports.administrators.isAdministrator({ principalId: JANA, scopeId: COMPANY_SCOPE, tenantId: TENANT }),
          ),
          'the live authority rows',
        ),
      ).toBe(true);
    }),
  );

  suite.effect('opens a transaction of its own, with the isolation the work asks for', () =>
    Effect.gen(function* openedTransaction() {
      const jana = yield* scopeFor(JANA);
      const pool = recordingPool(jana);
      const transactions = requestTransactions(pool.database);
      expect(transactions.readIsolation).toBe('request-repeatable-read');

      // A command asks for no isolation at all and runs in the transaction the pool opened for it.
      const written = yield* transactions
        .scoped(jana, new Set<string>(), (given) => Effect.succeed(given))
        .pipe(Effect.orDie);
      expect(written).toBe(pool.transaction);
      expect(pool.opened).toStrictEqual([undefined]);
      // A read asks for REPEATABLE READ, and the pool is the one that applies it (not the read).
      const read = yield* transactions
        .scopedRead(jana, new Set<string>(), (given) => Effect.succeed(given))
        .pipe(Effect.orDie);
      expect(read).toBe(pool.transaction);
      expect(pool.opened).toStrictEqual([undefined, { isolationLevel: 'repeatable read' }]);
      // Each call installed and verified the request's scope on its own transaction in one statement.
      expect(pool.statements).toEqual([...scopeStatements, ...scopeStatements]);
      // A failure of the body reaches the caller unchanged, so a rolled-back read stays a failure.
      const refusal = intentUnavailable('The intent store refused this read');
      expect(yield* Effect.flip(transactions.scoped(jana, new Set<string>(), () => Effect.fail(refusal)))).toBe(
        refusal,
      );
    }),
  );

  suite.effect('uses the caller transaction for every read and never opens one of its own', () =>
    Effect.gen(function* joinedTransaction() {
      const jana = yield* scopeFor(JANA);
      const statements: string[] = [];
      const caller = seamTransaction(jana, statements);
      const transactions = callerTransactions(caller, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);

      // The source states what it is: the caller's snapshot, never a level it could have chosen.
      expect(transactions.readIsolation).toBe('caller-transaction');
      // A command and a read both run in the very transaction object the caller opened...
      const written = yield* transactions
        .scoped(jana, new Set<string>(), (given) => Effect.succeed(given))
        .pipe(Effect.orDie);
      const read = yield* transactions
        .scopedRead(jana, new Set<string>(), (given) => Effect.succeed(given))
        .pipe(Effect.orDie);
      expect(written).toBe(caller);
      expect(read).toBe(caller);
      // ...and neither opened, ended or partitioned it: the only statements are the scope's own, one per call.
      expect(statements).toEqual([...scopeStatements, ...scopeStatements]);
      const refusal = intentUnavailable('The owner transaction refused this read');
      expect(yield* Effect.flip(transactions.scopedRead(jana, new Set<string>(), () => Effect.fail(refusal)))).toBe(
        refusal,
      );
    }),
  );

  suite.effect('binds a claim to the caller transaction through the owner join', () =>
    Effect.gen(function* joinedReads() {
      const crypto = yield* Crypto.Crypto;
      const jana = yield* scopeFor(JANA);
      // A unit check has no connection; the seam only has to hand the body the caller's own
      // transaction, which is what this identity states.
      const caller: CoreTransaction = Object.create(null);
      const joinedTransactions: CoreTransaction[] = [];
      const ports = liveApprovalsPorts(
        liveServices(crypto, {
          join: (transaction) => {
            joinedTransactions.push(transaction);
            return liveServices(crypto, {
              records: recordsNamed('the joined records'),
              transactions: callerTransactions(caller, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
            });
          },
        }),
        jana,
      );
      const bound = ports.inTransaction?.(caller);
      expect(bound === undefined).toBe(false);
      expect(joinedTransactions).toStrictEqual([caller]);
      expect(yield* recordsSourceOf(ports)).toBe('the scope records');
      expect(yield* recordsSourceOf(bound ?? ports)).toBe('the joined records');
    }),
  );

  suite.effect('offers no transaction-bound ports when the composition cannot join one', () =>
    Effect.gen(function* unjoinedComposition() {
      const crypto = yield* Crypto.Crypto;
      const jana = yield* scopeFor(JANA);
      // The same live services without `join`: a claim has no transaction-bound authority and says so
      // by not offering one, which `execute` reports as unavailability rather than proving elsewhere.
      const ports = liveApprovalsPorts(
        {
          crypto,
          intent: neverReadIntent,
          loadRelease: () => Effect.succeedSome(snapshotOf([releaseEntry])),
          records: recordsNamed('the scope records'),
          transactions: tripwired('the live authority rows'),
        },
        jana,
      );
      expect(ports.inTransaction).toBe(undefined);
      expect(yield* recordsSourceOf(ports)).toBe('the scope records');
    }),
  );

  suite.effect('pins a role binding only from the live assignments of one scope', () =>
    Effect.sync(() => {
      const otherRevision = RoleRevisionIdSchema.make(uid(43));
      const otherRole = RoleIdSchema.make(uid(44));
      expect(pinnedRevisionByRole([{ roleId: ROLE, roleRevisionId: REVISION }]).get(ROLE)).toBe(REVISION);
      // Two live revisions of one role is intent the projection refuses, so no binding is proven.
      expect(
        pinnedRevisionByRole([
          { roleId: ROLE, roleRevisionId: REVISION },
          { roleId: ROLE, roleRevisionId: otherRevision },
        ]).size,
      ).toBe(0);
      // Two roles keep their own binding; one role's revision is never folded into another's.
      expect(
        pinnedRevisionByRole([
          { roleId: ROLE, roleRevisionId: REVISION },
          { roleId: otherRole, roleRevisionId: otherRevision },
        ]).size,
      ).toBe(2);
      expect(pinnedRevisionByRole([]).size).toBe(0);
    }),
  );
});
