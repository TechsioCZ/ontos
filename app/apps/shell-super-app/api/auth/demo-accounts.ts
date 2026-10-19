/**
 * Sales-demo people administration of the current company (accounts-admin lane).
 *
 * The company administrator lists the people of the selected company with their demo role, creates an account
 * with a predefined role, changes the role and deactivates / reactivates the account. Every change runs the Core
 * Action `core.identity.manage-demo-account` (tenant `manage_identity`, explicit executor grant, sensitive audit),
 * so authorization, idempotency and the audit trail are Core's. After the Action committed, the endpoint writes
 * the same Better Auth rows and SpiceDB grants `scripts/demo/reset-permissions.mts` writes for the seeded
 * personas: grants are copied from the role's template persona, not re-implemented.
 */
import { createHash } from 'node:crypto';

import { ActionRuntime, manageDemoAccountAction, openDemoAccountGrants } from '@app/core-runtime';
import type { DemoAccountGrants, ManageDemoAccountPayload, TrustedPrincipalContext } from '@app/core-runtime';
import { hashPassword } from 'better-auth/crypto';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Data, DateTime, Effect } from 'effect';

import type { DemoAccountListResponse, ManageDemoAccountRequest, ManageDemoAccountResponse } from '../../shared/api.ts';
import { AuthDatabase } from './db/client.ts';
import { account, user } from './db/schema.ts';

/** Read-only views of the Core tables this lane reads (the runtime role may select them). */
const core = pgSchema('core');
const corePrincipals = core.table('principals', {
  displayName: text('display_name').notNull(),
  kind: text('kind').notNull(),
  principalId: uuid('principal_id').notNull(),
  status: text('status').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});
const coreBindings = core.table('principal_auth_bindings', {
  principalId: uuid('principal_id').notNull(),
  provider: text('provider').notNull(),
  providerSubjectId: text('provider_subject_id').notNull(),
  status: text('status').notNull(),
  subjectType: text('subject_type').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});
const coreLegalEntities = core.table('legal_entities', {
  legalEntityId: uuid('legal_entity_id').notNull(),
  legalName: text('legal_name').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});
const coreAuditEvents = core.table('audit_events', {
  auditEventId: uuid('audit_event_id').notNull(),
  eventType: text('event_type').notNull(),
  evidenceJson: jsonb('evidence_json').$type<Readonly<Record<string, unknown>>>().notNull(),
  legalEntityId: uuid('legal_entity_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  outcome: text('outcome').notNull(),
  outcomeCode: text('outcome_code').notNull(),
  principalId: uuid('principal_id'),
  tenantId: uuid('tenant_id').notNull(),
});

/** Insert shape of `core.audit_events` for denials decided before the Core Action runs. */
const coreAuditEventsWrite = core.table('audit_events', {
  auditProfile: text('audit_profile').notNull(),
  authBindingId: uuid('auth_binding_id'),
  authMethod: text('auth_method').notNull(),
  eventType: text('event_type').notNull(),
  evidenceJson: jsonb('evidence_json').$type<Readonly<Record<string, unknown>>>().notNull(),
  legalEntityId: uuid('legal_entity_id'),
  outcome: text('outcome').notNull(),
  outcomeCode: text('outcome_code').notNull(),
  outcomeStage: text('outcome_stage').notNull(),
  principalId: uuid('principal_id'),
  targetModuleKey: text('target_module_key'),
  tenantId: uuid('tenant_id').notNull(),
});

const ACTION_KEY = 'core.identity.manage-demo-account';
const DEMO_PASSWORD = 'password1234';

interface DemoRole {
  readonly administrator: boolean;
  readonly description: string;
  readonly key: string;
  readonly label: string;
  /** Persona whose grants define the role (seeded by the demo permission scripts). */
  readonly templateEmail: string;
}
interface CompanyRoles {
  readonly roles: readonly DemoRole[];
  /** Roles of the seeded personas, by e-mail, until an administrator changes them. */
  readonly seeded: Readonly<Record<string, string>>;
}

const role = (key: string, label: string, templateEmail: string, description: string, administrator = false) => ({
  administrator,
  description,
  key,
  label,
  templateEmail,
});

/** Predefined role sets per company (proposal of a minimal configuration, not a customer-approved matrix). */
const companyRoles: Readonly<Record<string, CompanyRoles>> = {
  '71000000-0000-4000-8000-000000000020': {
    roles: [
      role('headOfSales', 'Vedoucí obchodu (správce)', 'obchod@demo.ontos', 'Celá agenda firmy a správa lidí.', true),
      role(
        'salesRep',
        'Obchodník',
        'obchodnik@demo.ontos',
        'Zákazníci, objednávky a obchodní případy; faktury jen čte.',
      ),
      role('accountant', 'Účetní', 'ucetni@demo.ontos', 'Faktury a platby; ostatní agendy jen čte.'),
      role('warehouse', 'Skladník', 'sklad@demo.ontos', 'Produkty, sklad a úkoly.'),
    ],
    seeded: {
      'obchod@demo.ontos': 'headOfSales',
      'obchodnik@demo.ontos': 'salesRep',
      'sklad@demo.ontos': 'warehouse',
      'ucetni@demo.ontos': 'accountant',
    },
  },
  '71000000-0000-4000-8000-000000000021': {
    roles: [
      role('management', 'Vedení', 'management@siampark.demo', 'Přehledy, schvalování a správa lidí.', true),
      role('operations', 'Provoz', 'operations@siampark.demo', 'Majetek, prostory, úkoly a závady.'),
      role('finance', 'Finance', 'finance@siampark.demo', 'Fakturace, platby a upomínky.'),
      role('external', 'Externí obchodník', 'external@siampark.demo', 'Jen svěřené kontakty a případy, bez financí.'),
    ],
    seeded: {
      'external@siampark.demo': 'external',
      'finance@siampark.demo': 'finance',
      'management@siampark.demo': 'management',
      'operations@siampark.demo': 'operations',
    },
  },
  '71000000-0000-4000-8000-000000000022': {
    roles: [
      role('crmAdmin', 'Správce', 'spravce@hanak.demo', 'Správa lidí, rolí a všech klientů.', true),
      role('crmManager', 'Vedoucí obchodu', 'vedouci@hanak.demo', 'Všichni klienti, přidělování a souhrny týmu.'),
      role('crmRep', 'Obchodník', 'obchodnik.a@hanak.demo', 'Jen svěření klienti, jejich kontakty a návštěvy.'),
    ],
    seeded: {
      'obchodnik.a@hanak.demo': 'crmRep',
      'obchodnik.b@hanak.demo': 'crmRep',
      'spravce@hanak.demo': 'crmAdmin',
      'vedouci@hanak.demo': 'crmManager',
    },
  },
  '71000000-0000-4000-8000-000000000023': {
    roles: [
      role(
        'eshopAdmin',
        'Správce e-shopu',
        'eshop@kavarna.demo',
        'Katalog, objednávky, zákazníci a správa lidí.',
        true,
      ),
      role('fulfilment', 'Expedice', 'expedice@kavarna.demo', 'Vyřizování a odesílání objednávek.'),
    ],
    seeded: { 'eshop@kavarna.demo': 'eshopAdmin', 'expedice@kavarna.demo': 'fulfilment' },
  },
};

export class DemoAccountForbidden extends Data.TaggedError('DemoAccountForbidden')<{ readonly reason: string }> {}
export class DemoAccountInvalid extends Data.TaggedError('DemoAccountInvalid')<{ readonly reason: string }> {}
export class DemoAccountConflict extends Data.TaggedError('DemoAccountConflict')<{ readonly reason: string }> {}
export class DemoAccountUnavailable extends Data.TaggedError('DemoAccountUnavailable')<{ readonly cause: unknown }> {}

const unavailable = (cause: unknown) => new DemoAccountUnavailable({ cause });

export interface DemoAccountCaller {
  readonly legalName: string;
  readonly principal: TrustedPrincipalContext & { readonly legalEntityId: string };
}

const rolesOf = (legalEntityId: string) => companyRoles[legalEntityId];

/** Current demo role per principal: Core audit evidence of this Action, then the seeded persona roles. */
const assignedRoles = Effect.fn('DemoAccounts.assignedRoles')(function* assignedRoles(
  tenantId: string,
  legalEntityId: string,
) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ evidence: coreAuditEvents.evidenceJson })
    .from(coreAuditEvents)
    .where(
      and(
        eq(coreAuditEvents.tenantId, tenantId),
        eq(coreAuditEvents.legalEntityId, legalEntityId),
        eq(coreAuditEvents.outcome, 'succeeded'),
        eq(coreAuditEvents.eventType, 'action.executed'),
        sql`${coreAuditEvents.evidenceJson}->>'actionKey' = ${ACTION_KEY}`,
      ),
    )
    .orderBy(asc(coreAuditEvents.occurredAt))
    .pipe(Effect.mapError(unavailable));
  const roles = new Map<string, string>();
  for (const { evidence } of rows) {
    const target = evidence['targetPrincipalId'];
    const next = evidence['newRoleKey'];
    if (typeof target === 'string' && typeof next === 'string') {
      roles.set(target, next);
    }
  }
  return roles;
});

interface Person {
  readonly authUserId: string | null;
  readonly displayName: string;
  readonly email: string | null;
  readonly principalId: string;
  readonly status: 'active' | 'archived' | 'disabled';
}

const loadPeople = Effect.fn('DemoAccounts.loadPeople')(function* loadPeople(
  tenantId: string,
  principalIds: readonly string[],
) {
  if (principalIds.length === 0) {
    return [] as readonly Person[];
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({
      authUserId: coreBindings.providerSubjectId,
      displayName: corePrincipals.displayName,
      principalId: corePrincipals.principalId,
      status: corePrincipals.status,
    })
    .from(corePrincipals)
    .leftJoin(
      coreBindings,
      and(
        eq(coreBindings.tenantId, corePrincipals.tenantId),
        eq(coreBindings.principalId, corePrincipals.principalId),
        eq(coreBindings.provider, 'better_auth'),
        eq(coreBindings.subjectType, 'user'),
      ),
    )
    .where(
      and(
        eq(corePrincipals.tenantId, tenantId),
        eq(corePrincipals.kind, 'human'),
        inArray(corePrincipals.principalId, [...principalIds]),
      ),
    )
    .pipe(Effect.mapError(unavailable));
  const userIds = rows.flatMap((row) => (row.authUserId === null ? [] : [row.authUserId]));
  const users =
    userIds.length === 0
      ? []
      : yield* executor
          .select({ email: user.email, id: user.id })
          .from(user)
          .where(inArray(user.id, userIds))
          .pipe(Effect.mapError(unavailable));
  const emails = new Map(users.map((entry) => [entry.id, entry.email]));
  const byPrincipal = new Map<string, Person>();
  for (const row of rows) {
    if (!byPrincipal.has(row.principalId)) {
      byPrincipal.set(row.principalId, {
        authUserId: row.authUserId,
        displayName: row.displayName,
        email: row.authUserId === null ? null : (emails.get(row.authUserId) ?? null),
        principalId: row.principalId,
        status: row.status === 'disabled' || row.status === 'archived' ? row.status : 'active',
      });
    }
  }
  return [...byPrincipal.values()];
});

const roleKeyOf = (
  person: Pick<Person, 'email' | 'principalId'>,
  assigned: ReadonlyMap<string, string>,
  roles: CompanyRoles,
) => assigned.get(person.principalId) ?? (person.email === null ? undefined : roles.seeded[person.email.toLowerCase()]);

const principalByEmail = Effect.fn('DemoAccounts.principalByEmail')(function* principalByEmail(
  tenantId: string,
  email: string,
) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ principalId: coreBindings.principalId })
    .from(user)
    .innerJoin(
      coreBindings,
      and(
        eq(coreBindings.providerSubjectId, user.id),
        eq(coreBindings.provider, 'better_auth'),
        eq(coreBindings.subjectType, 'user'),
        eq(coreBindings.tenantId, tenantId),
      ),
    )
    .where(eq(user.email, email))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  const [row] = rows;
  if (row === undefined) {
    return yield* new DemoAccountUnavailable({ cause: `Role template ${email} is not provisioned` });
  }
  return row.principalId;
});

/** The caller must hold an administrator role in the selected company (Core additionally checks `manage_identity`). */
const requireAdministrator = Effect.fn('DemoAccounts.requireAdministrator')(function* requireAdministrator(
  caller: DemoAccountCaller,
  grants: DemoAccountGrants,
) {
  const roles = rolesOf(caller.principal.legalEntityId);
  if (roles === undefined) {
    return yield* new DemoAccountForbidden({ reason: 'This company has no people administration' });
  }
  const members = yield* grants
    .companyMembers(caller.principal.tenantId, caller.principal.legalEntityId)
    .pipe(Effect.mapError(unavailable));
  const assigned = yield* assignedRoles(caller.principal.tenantId, caller.principal.legalEntityId);
  const [self] = yield* loadPeople(caller.principal.tenantId, [caller.principal.principalId]);
  const selfRole =
    self === undefined ? undefined : roles.roles.find((entry) => entry.key === roleKeyOf(self, assigned, roles));
  if (!members.includes(caller.principal.principalId) || selfRole?.administrator !== true) {
    return yield* new DemoAccountForbidden({ reason: 'Only the company administrator manages people' });
  }
  return { assigned, members, roles };
});

const legalNames = Effect.fn('DemoAccounts.legalNames')(function* legalNames(tenantId: string) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ legalEntityId: coreLegalEntities.legalEntityId, legalName: coreLegalEntities.legalName })
    .from(coreLegalEntities)
    .where(eq(coreLegalEntities.tenantId, tenantId))
    .pipe(Effect.mapError(unavailable));
  return new Map(rows.map((row) => [row.legalEntityId, row.legalName]));
});

const auditTrail = Effect.fn('DemoAccounts.auditTrail')(function* auditTrail(
  tenantId: string,
  legalEntityId: string,
  members: readonly string[],
) {
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({
      actorName: corePrincipals.displayName,
      auditEventId: coreAuditEvents.auditEventId,
      eventType: coreAuditEvents.eventType,
      evidence: coreAuditEvents.evidenceJson,
      occurredAt: coreAuditEvents.occurredAt,
      outcome: coreAuditEvents.outcome,
      outcomeCode: coreAuditEvents.outcomeCode,
      principalId: coreAuditEvents.principalId,
    })
    .from(coreAuditEvents)
    .leftJoin(
      corePrincipals,
      and(
        eq(corePrincipals.tenantId, coreAuditEvents.tenantId),
        eq(corePrincipals.principalId, coreAuditEvents.principalId),
      ),
    )
    .where(
      and(
        eq(coreAuditEvents.tenantId, tenantId),
        or(
          and(
            eq(coreAuditEvents.legalEntityId, legalEntityId),
            sql`${coreAuditEvents.evidenceJson}->>'actionKey' = ${ACTION_KEY}`,
            sql`${coreAuditEvents.eventType} in ('action.executed', 'action.rejected')`,
          ),
          // Requests of deactivated accounts of this company, rejected and audited by the principal resolver.
          members.length === 0
            ? sql`false`
            : and(
                eq(coreAuditEvents.eventType, 'authn.rejected'),
                eq(coreAuditEvents.outcomeCode, 'principal_inactive'),
                inArray(coreAuditEvents.principalId, [...members]),
              ),
        ),
      ),
    )
    .orderBy(desc(coreAuditEvents.occurredAt))
    .limit(80)
    .pipe(Effect.mapError(unavailable));
  const targets = [
    ...new Set(
      rows.flatMap(({ evidence }) =>
        typeof evidence['targetPrincipalId'] === 'string' ? [evidence['targetPrincipalId']] : [],
      ),
    ),
  ];
  const people = yield* loadPeople(tenantId, targets);
  const names = new Map(people.map((person) => [person.principalId, person.displayName]));
  return rows.map((row) => {
    const details: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(row.evidence)) {
      if (key !== 'actionKey' && key !== 'resultHash' && (typeof value === 'string' || value === null)) {
        details[key] = value;
      }
    }
    if (row.eventType === 'authn.rejected' && row.principalId !== null) {
      details['targetPrincipalId'] = row.principalId;
    }
    const target = details['targetPrincipalId'];
    return {
      actorName: row.actorName,
      auditEventId: row.auditEventId,
      details,
      eventType: row.eventType,
      occurredAt: DateTime.formatIso(DateTime.fromDateUnsafe(row.occurredAt)),
      outcome: row.outcome,
      outcomeCode: row.outcomeCode,
      targetName:
        typeof target === 'string'
          ? (names.get(target) ?? (typeof details['displayName'] === 'string' ? details['displayName'] : null))
          : null,
    };
  });
});

export const listDemoAccounts = Effect.fn('DemoAccounts.list')(function* listDemoAccounts(caller: DemoAccountCaller) {
  const grants = yield* openDemoAccountGrants.pipe(Effect.mapError(unavailable));
  const { assigned, members, roles } = yield* requireAdministrator(caller, grants);
  const { legalEntityId, principalId, tenantId } = caller.principal;
  const people = yield* loadPeople(tenantId, members);
  const companies = yield* legalNames(tenantId);
  const accounts = yield* Effect.forEach(
    people,
    (person) =>
      grants.companiesOf(person.principalId).pipe(
        Effect.mapError(unavailable),
        Effect.map((memberships) => {
          const key = roleKeyOf(person, assigned, roles);
          const current = roles.roles.find((entry) => entry.key === key);
          return {
            displayName: person.displayName,
            editable: person.principalId !== principalId,
            email: person.email,
            otherCompanies: memberships
              .filter((company) => company !== legalEntityId)
              .map((company) => companies.get(company) ?? company),
            principalId: person.principalId,
            roleKey: current?.key ?? null,
            roleLabel: current?.label ?? null,
            self: person.principalId === principalId,
            status: person.status,
          };
        }),
      ),
    { concurrency: 4 },
  );
  const audit = yield* auditTrail(tenantId, legalEntityId, members);
  const response: DemoAccountListResponse = {
    accounts: accounts.toSorted(
      (left, right) =>
        Number(right.status === 'active') - Number(left.status === 'active') ||
        left.displayName.localeCompare(right.displayName, 'cs'),
    ),
    audit,
    canManage: true,
    company: { legalEntityId, legalName: caller.legalName },
    roles: roles.roles.map(({ administrator, description, key, label }) => ({
      administrator,
      description,
      key,
      label,
    })),
  };
  return response;
}, Effect.scoped);

/** Deterministic IDs per idempotency key, so a retried create replays the same Core Action. */
const derivedUuid = (seed: string) => {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const ensureBetterAuthUser = Effect.fn('DemoAccounts.ensureBetterAuthUser')(function* ensureBetterAuthUser(input: {
  readonly authUserId: string;
  readonly displayName: string;
  readonly email: string;
}) {
  const { executor } = yield* AuthDatabase;
  // oxlint-disable-next-line typescript/promise-function-async -- Effect owns the Better Auth crypto boundary.
  const password = yield* Effect.tryPromise({ catch: unavailable, try: () => hashPassword(DEMO_PASSWORD) });
  const now = yield* DateTime.nowAsDate;
  yield* executor
    .insert(user)
    .values({ banned: false, email: input.email, emailVerified: true, id: input.authUserId, name: input.displayName })
    .onConflictDoNothing()
    .pipe(Effect.mapError(unavailable));
  yield* executor
    .insert(account)
    .values({
      accountId: input.authUserId,
      id: `${input.authUserId}-credential`,
      password,
      providerId: 'credential',
      updatedAt: now,
      userId: input.authUserId,
    })
    .onConflictDoNothing()
    .pipe(Effect.mapError(unavailable));
});

/** A non-administrator's attempt is denied before the Core Action runs; it is still written to the Core audit. */
const auditForbiddenAttempt = (caller: DemoAccountCaller, operation: string) =>
  AuthDatabase.pipe(
    Effect.flatMap(({ executor }) =>
      executor.insert(coreAuditEventsWrite).values({
        auditProfile: 'sensitive',
        authBindingId: caller.principal.authBindingId ?? null,
        authMethod: caller.principal.authMethod,
        eventType: 'action.rejected',
        evidenceJson: { actionKey: ACTION_KEY, operation, reason: 'company_administrator_required' },
        legalEntityId: caller.principal.legalEntityId,
        outcome: 'denied',
        outcomeCode: 'company_administrator_required',
        outcomeStage: 'authz',
        principalId: caller.principal.principalId,
        targetModuleKey: 'core.identity',
        tenantId: caller.principal.tenantId,
      }),
    ),
    Effect.ignore,
  );

export const manageDemoAccount = Effect.fn('DemoAccounts.manage')(function* manageDemoAccount(
  caller: DemoAccountCaller,
  request: ManageDemoAccountRequest,
  transport: { readonly correlationId: string; readonly idempotencyKey: string },
) {
  const grants = yield* openDemoAccountGrants.pipe(Effect.mapError(unavailable));
  const { assigned, members, roles } = yield* requireAdministrator(caller, grants).pipe(
    Effect.tapError((error) =>
      error._tag === 'DemoAccountForbidden' ? auditForbiddenAttempt(caller, request.operation) : Effect.void,
    ),
  );
  const { legalEntityId, tenantId } = caller.principal;
  const runtime = yield* ActionRuntime;
  const run = (payload: ManageDemoAccountPayload) =>
    runtime.runAction({ payload, principal: caller.principal, registration: manageDemoAccountAction, transport });
  const findRole = (key: string) => {
    const found = roles.roles.find((entry) => entry.key === key);
    return found === undefined
      ? Effect.fail(new DemoAccountInvalid({ reason: 'Unknown role for this company' }))
      : Effect.succeed(found);
  };
  if (request.operation === 'create') {
    const target = yield* findRole(request.roleKey);
    const email = request.email.toLowerCase();
    const { executor } = yield* AuthDatabase;
    const seed = `${tenantId}:${legalEntityId}:${transport.idempotencyKey}:${email}`;
    const authUserId = `demo-admin-${derivedUuid(`${seed}:user`)}`;
    const taken = yield* executor
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (taken.some((row) => row.id !== authUserId)) {
      return yield* new DemoAccountConflict({ reason: 'An account with this e-mail already exists' });
    }
    const templatePrincipalId = yield* principalByEmail(tenantId, target.templateEmail);
    const result = yield* run({
      authBindingId: derivedUuid(`${seed}:binding`),
      authUserId,
      displayName: request.displayName,
      email,
      operation: 'create',
      principalId: derivedUuid(`${seed}:principal`),
      roleKey: target.key,
      roleLabel: target.label,
    });
    yield* ensureBetterAuthUser({ authUserId, displayName: request.displayName, email });
    const copied = yield* grants
      .assignRole({ legalEntityId, principalId: result.principalId, replace: false, templatePrincipalId })
      .pipe(Effect.mapError(unavailable));
    const response: ManageDemoAccountResponse = {
      grantsCopied: copied.granted,
      grantsRevoked: copied.revoked,
      operation: result.operation,
      principalId: result.principalId,
      status: result.status,
    };
    return response;
  }
  if (!members.includes(request.principalId)) {
    return yield* new DemoAccountInvalid({ reason: 'The person is not a member of this company' });
  }
  if (request.operation === 'change-role') {
    const target = yield* findRole(request.roleKey);
    const [person] = yield* loadPeople(tenantId, [request.principalId]);
    const previous =
      person === undefined ? undefined : roles.roles.find((entry) => entry.key === roleKeyOf(person, assigned, roles));
    const templatePrincipalId = yield* principalByEmail(tenantId, target.templateEmail);
    const result = yield* run({
      operation: 'change-role',
      previousRoleKey: previous?.key ?? null,
      previousRoleLabel: previous?.label ?? null,
      principalId: request.principalId,
      roleKey: target.key,
      roleLabel: target.label,
    });
    const changed = yield* grants
      .assignRole({ legalEntityId, principalId: request.principalId, replace: true, templatePrincipalId })
      .pipe(Effect.mapError(unavailable));
    const response: ManageDemoAccountResponse = {
      grantsCopied: changed.granted,
      grantsRevoked: changed.revoked,
      operation: result.operation,
      principalId: result.principalId,
      status: result.status,
    };
    return response;
  }
  const result = yield* run({
    expectedStatus: request.expectedStatus,
    newStatus: request.newStatus,
    operation: 'change-status',
    principalId: request.principalId,
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  });
  const response: ManageDemoAccountResponse = {
    grantsCopied: 0,
    grantsRevoked: 0,
    operation: result.operation,
    principalId: result.principalId,
    status: result.status,
  };
  return response;
}, Effect.scoped);
