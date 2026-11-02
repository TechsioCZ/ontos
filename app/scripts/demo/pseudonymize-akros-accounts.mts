#!/usr/bin/env node
/** Stage-only, fixed demo tenant: plan → apply create (phase A) → warm-up switch deploy → apply retire (phase B) → verify.
 * No Core/Auth SQL writes: the native stage-accounts installer creates accounts, audited Actions retire Core
 * identities/memberships/role assignments, and the native Auth installer bans retired credentials. Exact discovered
 * SpiceDB subject grants are copied to the new identities.
 */
import { randomUUID } from 'node:crypto';

import {
  ActionRuntime,
  ContextAccess,
  manageDemoAccountAction,
  setCompanyMembershipAction,
  setScopedRoleMembershipAction,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { StageAccountsFileSchema } from '@app/core-runtime/install/stage-accounts-file';
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { verifyPassword } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import { Array as Arr, Config, Console, Effect, Exit, FileSystem, Option, Order, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { AuthDatabase } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { account, session, user } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import {
  bootstrapStageAccounts,
  loadStageAccountsConfiguration,
} from '../../apps/shell-super-app/api/auth/stage-accounts-bootstrap-runtime-infrastructure.ts';
import {
  legalEntities,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenantModuleStates,
  tenants,
} from '../../packages/core-runtime/src/db/schema.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import type { SpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-rpc.ts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';
import { AgentProfileReadDatabase } from './agent-profile-setup.mts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { demoHumanAccounts } from './permissions.mts';
import {
  AccountPseudonymError,
  accountPlanFingerprint,
  accountPseudonymFailure as fail,
  isPseudonymSource,
  PseudonymAccountPlanSchema,
  PseudonymAccountSchema,
  pseudonymAccountIdentity,
  pseudonymRoleId,
  remapAccountRelationships,
  sameAccounts,
  scopedRoleAssignments,
  validatePseudonymAccountPlan,
} from './pseudonymize-akros-accounts-policy.mts';
import type { PseudonymAccount, PseudonymRole } from './pseudonymize-akros-accounts-policy.mts';
import { discoverPseudonymEmployees, reconcilePseudonymEmployees } from './pseudonymize-akros-accounts-workforce.mts';
import { reconcileServiceGrants } from './reconcile-stage-service-grants.mts';
import { connectSeedClient } from './seed-client.mts';
import { warmupAccounts } from './warmup-accounts.mts';

const consistent = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });
const modes = ['plan', 'apply', 'verify'] as const;
const phases = ['create', 'retire'] as const;
const reason = 'Operator-approved synthetic demo account pseudonymization';
const planCodec = Schema.fromJsonString(PseudonymAccountPlanSchema);
const stageShellUrl = 'https://ontos-stage.web-revolution.cz';

/** The documented demo password; overridable for a rotated stage, never logged. */
const demoAccountPassword = Config.Redacted('ONTOS_DEMO_ACCOUNT_PASSWORD').pipe(
  Config.withDefault(Redacted.make('password1234')),
);

/** Enumerate the LIVE schema, not a hardcoded subset: market, storefront and scoped-role grants must survive too. */
const readSubjectGrants = Effect.fn('PseudonymAccount.readGrants')(function* readGrants(
  rpc: SpiceDbRpc,
  subjectType: 'principal' | 'scoped_role',
  subjectId: string,
) {
  const { schemaText } = yield* rpc.readSchema(v1.ReadSchemaRequest.create({}));
  const types = [...schemaText.matchAll(/\bdefinition\s+(?<type>[a-z][a-z0-9_]*)\s*\{/gu)].map(
    (match) => match.groups?.type ?? '',
  );
  if (types.length === 0 || types.includes('')) {
    return yield* fail('The live authorization schema cannot be enumerated');
  }
  const groups = yield* Effect.forEach(
    types,
    (resourceType) =>
      rpc.readRelationships(
        v1.ReadRelationshipsRequest.create({
          consistency: consistent,
          relationshipFilter: { optionalSubjectFilter: { optionalSubjectId: subjectId, subjectType }, resourceType },
        }),
      ),
    { concurrency: 1 },
  );
  const rows = groups.flat().flatMap(({ relationship }) => (relationship === undefined ? [] : [relationship]));
  return Arr.sort(
    rows,
    Order.mapInput(Order.String, (row: v1.Relationship) => v1.Relationship.toJsonString(row)),
  );
});

const readMemberships = Effect.fn('PseudonymAccount.readMemberships')(function* readMemberships(principalId: string) {
  const { executor } = yield* AgentProfileReadDatabase;
  return yield* executor
    .select({
      affiliation: principalCompanyMemberships.affiliation,
      legalEntityId: principalCompanyMemberships.legalEntityId,
      revision: principalCompanyMemberships.revision,
      status: principalCompanyMemberships.status,
    })
    .from(principalCompanyMemberships)
    .where(
      and(
        eq(principalCompanyMemberships.tenantId, demoTenantId),
        eq(principalCompanyMemberships.principalId, principalId),
      ),
    )
    .orderBy(principalCompanyMemberships.legalEntityId);
});

/** Renamed scoped roles (e.g. the warm-up reader) need their exact role policy under the new role id. */
const renamedRolePolicy = Effect.fn('PseudonymAccount.renamedRolePolicy')(function* renamedRolePolicy(
  rpc: SpiceDbRpc,
  roles: readonly PseudonymRole[],
) {
  const result: v1.Relationship[] = [];
  for (const role of roles) {
    const oldRoleId = toScopedRoleObjectId(role);
    const newRoleId = pseudonymRoleId(oldRoleId);
    if (oldRoleId !== newRoleId) {
      for (const policy of yield* readSubjectGrants(rpc, 'scoped_role', oldRoleId)) {
        if (
          policy.optionalCaveat !== undefined ||
          policy.optionalExpiresAt !== undefined ||
          policy.subject?.object === undefined
        ) {
          return yield* fail('Conditional or incomplete scoped-role policy requires separate review');
        }
        result.push(
          v1.Relationship.create({
            ...policy,
            subject: { ...policy.subject, object: { ...policy.subject.object, objectId: newRoleId } },
          }),
        );
      }
    }
  }
  return result;
});

const discoverAccount = Effect.fn('PseudonymAccount.discoverOne')(function* discoverOne(
  rpc: SpiceDbRpc,
  person: { readonly email: string; readonly id: string },
  oldPrincipalId: string,
  oldDisplayName: string,
) {
  const memberships = yield* readMemberships(oldPrincipalId);
  if (
    !memberships.some(({ legalEntityId, status }) => legalEntityId === akrosDemoLegalEntityId && status === 'active')
  ) {
    return yield* fail(`Source is not an active member of the pseudonymous company: ${person.email}`);
  }
  const identity = pseudonymAccountIdentity(person.email, oldDisplayName);
  const original = yield* readSubjectGrants(rpc, 'principal', oldPrincipalId);
  const roles = yield* scopedRoleAssignments(original);
  const mapped = [
    ...(yield* remapAccountRelationships(original, oldPrincipalId, identity.newPrincipalId)),
    ...(yield* renamedRolePolicy(rpc, roles)),
  ];
  return yield* Schema.decodeUnknownEffect(PseudonymAccountSchema)({
    ...identity,
    memberships,
    oldDisplayName,
    oldEmail: person.email,
    oldPrincipalId,
    relationships: Arr.sort([...new Set(mapped.map((row) => v1.Relationship.toJsonString(row)))], Order.String),
    roles,
  });
});

const discoverAccounts = Effect.fn('PseudonymAccount.discover')(function* discoverAccounts(rpc: SpiceDbRpc) {
  const { executor } = yield* AgentProfileReadDatabase;
  const { executor: auth } = yield* AuthDatabase;
  const humans = yield* executor
    .select()
    .from(principals)
    .where(and(eq(principals.tenantId, demoTenantId), eq(principals.kind, 'human')));
  const bindings = yield* executor
    .select()
    .from(principalAuthBindings)
    .where(
      and(
        eq(principalAuthBindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
        eq(principalAuthBindings.subjectType, 'user'),
        eq(principalAuthBindings.provider, 'better_auth'),
      ),
    );
  const users = yield* auth.select({ email: user.email, id: user.id, name: user.name }).from(user);
  const result: PseudonymAccount[] = [];
  for (const person of users) {
    const allBindings = bindings.filter((binding) => binding.providerSubjectId === person.id);
    const candidates = allBindings.filter((binding) => binding.tenantId === demoTenantId);
    const source = candidates.flatMap((binding) => humans.filter((human) => human.principalId === binding.principalId));
    const [first] = source;
    if (isPseudonymSource(person.email, first?.displayName ?? person.name)) {
      if (
        first === undefined ||
        candidates.length !== 1 ||
        allBindings.some((binding) => binding.tenantId !== demoTenantId) ||
        source.length !== 1 ||
        first.status !== 'active' ||
        candidates[0]?.status !== 'active'
      ) {
        return yield* fail(
          `Account requires an exact active demo-tenant human binding before migration: ${person.email}`,
        );
      }
      result.push(yield* discoverAccount(rpc, person, first.principalId, first.displayName));
    }
  }
  const matched = new Set(result.map(({ oldPrincipalId }) => oldPrincipalId));
  if (humans.some((human) => /akros/iu.test(human.displayName) && !matched.has(human.principalId))) {
    return yield* fail(
      'An AKROS-named demo human has no unique active staff account; explicit governed mapping required',
    );
  }
  return Arr.sort(
    result,
    Order.mapInput(Order.String, ({ oldEmail }: PseudonymAccount) => oldEmail),
  );
});

const installAccount = Effect.fn('PseudonymAccount.install')(function* installAccount(
  row: PseudonymAccount,
  retire: boolean,
) {
  const { executor } = yield* AgentProfileReadDatabase;
  const environment = yield* Config.all({
    BETTER_AUTH_SECRET: Config.Redacted('BETTER_AUTH_SECRET'),
    BETTER_AUTH_URL: Config.String('BETTER_AUTH_URL'),
    DATABASE_ADMIN_URL: Config.Redacted('DATABASE_ADMIN_URL'),
  });
  const password = yield* demoAccountPassword;
  const [tenant] = yield* executor.select().from(tenants).where(eq(tenants.tenantId, demoTenantId));
  const [module] = yield* executor
    .select()
    .from(tenantModuleStates)
    .where(and(eq(tenantModuleStates.tenantId, demoTenantId), eq(tenantModuleStates.moduleKey, 'work.tasks')));
  if (tenant?.status !== 'active' || module?.state !== 'active') {
    return yield* fail('Existing demo tenant and work.tasks must be active');
  }
  for (const membership of row.memberships) {
    const [company] = yield* executor
      .select()
      .from(legalEntities)
      .where(and(eq(legalEntities.tenantId, demoTenantId), eq(legalEntities.legalEntityId, membership.legalEntityId)));
    if (company?.status !== 'active') {
      return yield* fail('An account company is no longer active');
    }
    const source = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toEncoded(StageAccountsFileSchema)))({
      actionAuthorization: { actionAssertions: [], roleGrants: [] },
      retiredAccountEmails: retire ? [row.oldEmail] : [],
      retiredTenants: [],
      schemaVersion: 4,
      scopedRoles: [],
      tenants: [
        {
          accounts: [
            {
              affiliation: membership.affiliation,
              authBindingId: row.newAuthBindingId,
              displayName: row.displayName,
              email: row.email,
              grants: { explicitActions: [], tenantRelations: [] },
              password: Redacted.value(password),
              principalId: row.newPrincipalId,
            },
          ],
          defaultLocale: tenant.defaultLocale,
          displayName: tenant.name,
          legalEntity: {
            legalEntityId: company.legalEntityId,
            legalName: company.legalName,
            registrationCountry: company.registrationCountry,
            registrationNumber: company.registrationNumber,
          },
          moduleKey: module.moduleKey,
          moduleStateId: module.tenantModuleStateId,
          slug: tenant.slug,
          tenantId: demoTenantId,
        },
      ],
    });
    const configuration = yield* loadStageAccountsConfiguration(() => Effect.succeed({ mode: 0o600, source }), {
      BETTER_AUTH_SECRET: Redacted.value(environment.BETTER_AUTH_SECRET),
      BETTER_AUTH_URL: environment.BETTER_AUTH_URL,
      DATABASE_ADMIN_URL: Redacted.value(environment.DATABASE_ADMIN_URL),
      ONTOS_STAGE_ACCOUNTS_FILE: 'reviewed-pseudonymous-demo-account-plan',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    });
    yield* bootstrapStageAccounts(configuration);
  }
  return row.memberships.length;
});

interface MembershipFacts {
  readonly affiliation: string | null;
  readonly legalEntityId: string;
  readonly status: string;
}
const sameMemberships = (expected: readonly MembershipFacts[], actual: readonly MembershipFacts[]) =>
  expected.length === actual.length &&
  expected.every(
    (row, index) =>
      row.affiliation === actual[index]?.affiliation &&
      row.legalEntityId === actual[index].legalEntityId &&
      row.status === actual[index].status,
  );

const verifyCredential = Effect.fn('PseudonymAccount.verifyCredential')(function* verifyCredential(
  row: PseudonymAccount,
  userId: string,
) {
  const { executor: auth } = yield* AuthDatabase;
  const credentials = yield* auth
    .select({ accountId: account.accountId, password: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')));
  const credential = credentials.length === 1 ? credentials[0] : undefined;
  if (credential?.password === null || credential?.password === undefined || credential.accountId !== userId) {
    return yield* fail(`New account does not have exact native credential evidence: ${row.email}`);
  }
  const hash = credential.password;
  const password = yield* demoAccountPassword;
  const passwordMatches = yield* Effect.tryPromise({
    catch: () => fail('Native credential verification is unavailable'),
    try: async () => await verifyPassword({ hash, password: Redacted.value(password) }),
  }).pipe(Effect.timeout('15 seconds'));
  if (!passwordMatches) {
    return yield* fail(`New account credential does not match the documented demo password: ${row.email}`);
  }
  return yield* Effect.void;
});

const verifyRetired = Effect.fn('PseudonymAccount.verifyRetired')(function* verifyRetired(
  row: PseudonymAccount,
  rpc: SpiceDbRpc,
) {
  const { executor } = yield* AgentProfileReadDatabase;
  const { executor: auth } = yield* AuthDatabase;
  const [old] = yield* executor
    .select({ status: principals.status })
    .from(principals)
    .where(and(eq(principals.tenantId, demoTenantId), eq(principals.principalId, row.oldPrincipalId)));
  const [oldAuth] = yield* auth
    .select({ banned: user.banned, id: user.id })
    .from(user)
    .where(eq(user.email, row.oldEmail));
  if (
    old?.status !== 'disabled' ||
    oldAuth?.banned !== true ||
    (yield* readMemberships(row.oldPrincipalId)).some(({ status }) => status !== 'departed')
  ) {
    return yield* fail(`Old account is not fully retired: ${row.oldEmail}`);
  }
  const credentials = yield* auth
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, oldAuth.id), eq(account.providerId, 'credential')));
  const sessions = yield* auth.select({ id: session.id }).from(session).where(eq(session.userId, oldAuth.id));
  if (credentials.length !== 0 || sessions.length !== 0) {
    return yield* fail(`Retired account retains credentials or sessions: ${row.oldEmail}`);
  }
  if ((yield* scopedRoleAssignments(yield* readSubjectGrants(rpc, 'principal', row.oldPrincipalId))).length > 0) {
    return yield* fail(
      `Old role revocation projection is pending for ${row.oldEmail}; rerun verify after the Core outbox worker completes`,
    );
  }
  return yield* Effect.void;
});

const verifyAccount = Effect.fn('PseudonymAccount.verify')(function* verifyAccount(
  row: PseudonymAccount,
  rpc: SpiceDbRpc,
  retired: boolean,
) {
  const { executor } = yield* AgentProfileReadDatabase;
  const { executor: auth } = yield* AuthDatabase;
  const [person] = yield* executor
    .select()
    .from(principals)
    .where(and(eq(principals.tenantId, demoTenantId), eq(principals.principalId, row.newPrincipalId)));
  const [authUser] = yield* auth
    .select({ banned: user.banned, emailVerified: user.emailVerified, id: user.id, name: user.name })
    .from(user)
    .where(eq(user.email, row.email));
  const [binding] = yield* executor
    .select()
    .from(principalAuthBindings)
    .where(eq(principalAuthBindings.principalAuthBindingId, row.newAuthBindingId));
  if (
    person?.status !== 'active' ||
    person.displayName !== row.displayName ||
    authUser?.banned === true ||
    authUser?.name !== row.displayName ||
    !authUser.emailVerified ||
    binding?.status !== 'active' ||
    binding.principalId !== row.newPrincipalId ||
    binding.providerSubjectId !== authUser.id
  ) {
    return yield* fail(`New account or native binding did not verify: ${row.email}`);
  }
  yield* verifyCredential(row, authUser.id);
  if (!sameMemberships(row.memberships, yield* readMemberships(row.newPrincipalId))) {
    return yield* fail(`New company memberships differ: ${row.email}`);
  }
  const relationships = row.relationships.map((text) => v1.Relationship.fromJsonString(text));
  yield* reconcileServiceGrants(rpc, relationships, 'verify');
  // No extra subject grants beyond the copied policy and native identity structure.
  const desired = new Set(row.relationships);
  if (
    (yield* readSubjectGrants(rpc, 'principal', row.newPrincipalId)).some(
      (edge) => !desired.has(v1.Relationship.toJsonString(edge)),
    )
  ) {
    return yield* fail(`New account has unexpected additional grants: ${row.email}`);
  }
  if (retired) {
    yield* verifyRetired(row, rpc);
  }
  return yield* Effect.void;
});

/** Preflight the entire target set before the first native credential write. */
const preflightTargets = Effect.fn('PseudonymAccount.preflight')(function* preflightTargets(
  rpc: SpiceDbRpc,
  accounts: readonly PseudonymAccount[],
) {
  const { executor } = yield* AgentProfileReadDatabase;
  const { executor: auth } = yield* AuthDatabase;
  for (const row of accounts) {
    const [existing] = yield* auth
      .select({ banned: user.banned, id: user.id, name: user.name })
      .from(user)
      .where(eq(user.email, row.email));
    const targetBindings =
      existing === undefined
        ? []
        : yield* executor
            .select()
            .from(principalAuthBindings)
            .where(eq(principalAuthBindings.providerSubjectId, existing.id));
    const [target] = yield* executor.select().from(principals).where(eq(principals.principalId, row.newPrincipalId));
    if (
      (existing !== undefined && (existing.name !== row.displayName || existing.banned === true)) ||
      targetBindings.some(
        (binding) =>
          binding.tenantId !== demoTenantId ||
          binding.principalId !== row.newPrincipalId ||
          binding.principalAuthBindingId !== row.newAuthBindingId ||
          binding.status !== 'active',
      ) ||
      (target !== undefined &&
        (target.tenantId !== demoTenantId ||
          target.displayName !== row.displayName ||
          target.kind !== 'human' ||
          target.status !== 'active'))
    ) {
      return yield* fail(`Target account conflicts with an existing identity: ${row.email}`);
    }
    const desired = new Set(row.relationships);
    if (
      (yield* readSubjectGrants(rpc, 'principal', row.newPrincipalId)).some(
        (edge) => !desired.has(v1.Relationship.toJsonString(edge)),
      )
    ) {
      return yield* fail(`Target account has unreviewed grants: ${row.email}`);
    }
  }
  return yield* Effect.void;
});

const retireOldAccount = Effect.fn('PseudonymAccount.retire')(function* retireOldAccount(
  rpc: SpiceDbRpc,
  row: PseudonymAccount,
  operator: Effect.Success<typeof authenticateAgentProfileOperator>,
  fingerprint: string,
) {
  const runtime = yield* ActionRuntime;
  const { executor } = yield* AgentProfileReadDatabase;
  const principalRef = { principalId: row.oldPrincipalId, tenantId: demoTenantId };
  const key = (suffix: string) => `pseudonym-account:${fingerprint}:${row.oldPrincipalId}:${suffix}`;
  const [old] = yield* executor
    .select({ status: principals.status })
    .from(principals)
    .where(and(eq(principals.tenantId, demoTenantId), eq(principals.principalId, row.oldPrincipalId)));
  if (old?.status === 'active') {
    yield* runtime
      .runAction({
        payload: {
          expectedStatus: 'active',
          newStatus: 'disabled',
          operation: 'change-status',
          principalId: row.oldPrincipalId,
          reason,
        },
        principal: { ...operator.principal, legalEntityId: akrosDemoLegalEntityId },
        registration: manageDemoAccountAction,
        transport: { correlationId: randomUUID(), idempotencyKey: key('disable') },
      })
      .pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void));
  } else if (old?.status !== 'disabled') {
    return yield* fail(`Old principal changed outside the reviewed transition: ${row.oldEmail}`);
  }
  for (const membership of yield* readMemberships(row.oldPrincipalId)) {
    if (membership.status !== 'departed') {
      const expected = row.memberships.find(({ legalEntityId }) => legalEntityId === membership.legalEntityId);
      if (expected === undefined || membership.revision !== expected.revision || membership.status !== 'active') {
        return yield* fail(`Old membership changed outside the reviewed transition: ${row.oldEmail}`);
      }
      yield* runtime
        .runAction({
          payload: {
            affiliation: membership.affiliation,
            expectedRevision: membership.revision,
            principalRef,
            reason,
            status: 'departed',
          },
          principal: { ...operator.principal, legalEntityId: membership.legalEntityId },
          registration: setCompanyMembershipAction,
          transport: { correlationId: randomUUID(), idempotencyKey: key(`${membership.legalEntityId}:depart`) },
        })
        .pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void));
    }
  }
  // Every role assignment in every scope: the reviewed ones plus any assigned since the plan.
  const live = yield* scopedRoleAssignments(yield* readSubjectGrants(rpc, 'principal', row.oldPrincipalId));
  const roles = new Map([...row.roles, ...live].map((role) => [toScopedRoleObjectId(role), role]));
  const { legalEntityId: _selectedCompany, ...tenantPrincipal } = operator.principal;
  for (const [roleId, role] of roles) {
    yield* runtime
      .runAction({
        payload: { operation: 'revoke', principalRef, reason, roleKey: role.roleKey },
        principal:
          role.legalEntityId === undefined
            ? tenantPrincipal
            : { ...tenantPrincipal, legalEntityId: role.legalEntityId },
        registration: setScopedRoleMembershipAction,
        transport: { correlationId: randomUUID(), idempotencyKey: key(`role:${accountPlanFingerprint(roleId)}`) },
      })
      .pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void));
  }
  // Native Auth retirement: ban, end sessions, delete the password credential of the old login.
  yield* installAccount(row, true);
  return roles.size;
});

const openSpiceDb = Effect.gen(function* openSpiceDb() {
  const environment = yield* Config.all({
    SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
    SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
    SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
  });
  const config = yield* parseSpiceDbConfig({
    ...environment,
    SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY),
  });
  return yield* Effect.acquireRelease(
    Effect.try({
      catch: () => fail('Stage authorization channel unavailable'),
      try: () => openSpiceDbGrpcRpc(config, 10_000),
    }),
    (client) => Effect.sync(() => client.close()),
  );
});

/** Workforce is owner data: only its public read and governed UpdateEmployee, as the authenticated superadmin. */
const openWorkforce = (fingerprint: string) =>
  Effect.acquireRelease(
    Effect.gen(function* connectWorkforce() {
      const email = yield* Config.String('ONTOS_AGENT_SETUP_EMAIL');
      const password = yield* Config.Redacted('ONTOS_AGENT_SETUP_PASSWORD');
      return yield* connectSeedClient(
        { legalEntityId: akrosDemoLegalEntityId, shellUrl: stageShellUrl, tenantId: demoTenantId },
        email,
        password,
        (_audience, _path, payload) =>
          Effect.succeed(`pseudonym-workforce:${fingerprint}:${accountPlanFingerprint(payload)}`),
      );
    }),
    (client) => client.signOut.pipe(Effect.ignore),
  );

const writePlan = Effect.fn('PseudonymAccount.writePlan')(function* writePlan(
  rpc: SpiceDbRpc,
  path: string,
  operatorPrincipalId: string,
) {
  const accounts = yield* discoverAccounts(rpc);
  const workforce = yield* openWorkforce('plan');
  const plan = yield* Schema.decodeUnknownEffect(PseudonymAccountPlanSchema)({
    accounts,
    employees: yield* discoverPseudonymEmployees(workforce, accounts),
    operatorPrincipalId,
    schemaVersion: 1,
    tenantId: demoTenantId,
  });
  if (!validatePseudonymAccountPlan(plan)) {
    return yield* fail('Account mapping is empty, ambiguous or contains a foreign identity');
  }
  const text = yield* Schema.encodeEffect(planCodec)(plan);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path, text, { flag: 'wx', mode: 0o600 });
  yield* Console.log({
    employees: plan.employees.map(({ email, fullName, oldEmail, oldFullName }) => ({
      email,
      fullName,
      oldEmail,
      oldFullName,
    })),
    fingerprint: accountPlanFingerprint(text),
    mappings: plan.accounts.map(({ email, memberships, oldEmail, relationships, roles }) => ({
      email,
      memberships: memberships.length,
      oldEmail,
      roles: roles.map(({ legalEntityId, roleKey }) => `${roleKey}${legalEntityId === undefined ? ' (tenant)' : ''}`),
      subjectGrants: relationships.length,
    })),
    mode: 'plan',
    path,
  });
  // The frozen plan (no credentials) is printed so the operator keeps it outside the replaceable container.
  return yield* Console.log(`PLAN-JSON ${text}`);
});

const readReviewedPlan = Effect.fn('PseudonymAccount.readReviewedPlan')(function* readReviewedPlan(
  path: string,
  reviewed: Option.Option<string>,
  operatorPrincipalId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(path);
  const text = yield* fs.readFileString(path);
  const plan = yield* Schema.decodeUnknownEffect(planCodec, { onExcessProperty: 'error' })(text);
  const fingerprint = accountPlanFingerprint(text);
  if (
    stat.type !== 'File' ||
    stat.mode % 0o100 !== 0 ||
    Option.isNone(reviewed) ||
    reviewed.value !== fingerprint ||
    plan.operatorPrincipalId !== operatorPrincipalId ||
    !validatePseudonymAccountPlan(plan)
  ) {
    return yield* fail('Exact owner-only plan and reviewed fingerprint for this authenticated operator required');
  }
  return { fingerprint, plan };
});

const main = (
  mode: (typeof modes)[number],
  phase: (typeof phases)[number],
  path: string,
  reviewed: Option.Option<string>,
) =>
  Effect.gen(function* pseudonymizeAccounts() {
    const rpc = yield* openSpiceDb;
    const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (authenticated) =>
      authenticated.close.pipe(Effect.ignore),
    );
    if (
      operator.principal.tenantId !== demoTenantId ||
      operator.principal.authMethod !== 'session' ||
      operator.principal.principalId !== demoHumanAccounts[0].principalId
    ) {
      return yield* fail('The overarching demo superadministrator must be the authenticated operator');
    }
    const access = yield* ContextAccess;
    const checkSuperadmin = access
      .legalEntities({
        legalEntityIds: [akrosDemoLegalEntityId],
        permission: 'access',
        principalId: operator.principal.principalId,
        tenantId: demoTenantId,
      })
      .pipe(
        Effect.flatMap((decisions) =>
          decisions.length === 1 && decisions[0]?.decision === 'allowed'
            ? Effect.void
            : fail('The overarching demo superadministrator must retain company access'),
        ),
      );
    yield* checkSuperadmin;
    if (mode === 'plan') {
      return yield* writePlan(rpc, path, operator.principal.principalId);
    }
    const { fingerprint, plan } = yield* readReviewedPlan(path, reviewed, operator.principal.principalId);
    if (mode === 'apply' && phase === 'create') {
      yield* preflightTargets(rpc, plan.accounts);
      if (!sameAccounts(yield* discoverAccounts(rpc), plan.accounts)) {
        return yield* fail('Source identities, memberships or grants changed; review a fresh plan');
      }
      for (const row of plan.accounts) {
        yield* installAccount(row, false);
        yield* reconcileServiceGrants(
          rpc,
          row.relationships.map((edge) => v1.Relationship.fromJsonString(edge)),
          'apply',
        );
      }
    }
    // Never retire an old login until EVERY new login and its exact membership/grants are verified.
    for (const row of plan.accounts) {
      yield* verifyAccount(row, rpc, false);
    }
    const workforce = yield* openWorkforce(fingerprint);
    yield* reconcilePseudonymEmployees(workforce, plan.employees, mode === 'apply' && phase === 'create');
    if (mode === 'apply' && phase === 'retire') {
      // The deployed warm-up switch is part of this code: old warm-up logins must no longer be used by deploys.
      if (!warmupAccounts.some(({ email }) => email === 'warmup@sroubarna.demo')) {
        return yield* fail('Deploy the prepared warm-up switch before retiring any old account');
      }
      for (const row of plan.accounts) {
        yield* retireOldAccount(rpc, row, operator, fingerprint);
      }
    }
    for (const row of plan.accounts) {
      yield* verifyAccount(row, rpc, phase === 'retire');
    }
    yield* checkSuperadmin;
    return yield* Console.log({ accounts: plan.accounts.length, failures: 0, fingerprint, mode, phase });
  }).pipe(Effect.scoped);

const command = Command.make(
  'pseudonymize-akros-accounts',
  {
    mode: Flag.Literals('mode', modes),
    phase: Flag.Literals('phase', phases).pipe(Flag.withDefault('create')),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, phase, plan, reviewed }) =>
    main(mode, phase, plan, reviewed).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(AccountPseudonymError)(failure)
            ? failure.reason
            : `Account pseudonymization stopped (${failure._tag}); credentials and provider details withheld`,
        ),
      ),
    ),
).pipe(Command.provide(AgentProfileOperatorLive));

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
