import { createHash } from 'node:crypto';

import { ContextAccess } from '@app/core-runtime';
import type { DemoAccountGrants, TrustedPrincipalContext } from '@app/core-runtime';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Data, DateTime, Effect } from 'effect';

import { AuthDatabase } from './db/client.ts';
import { user } from './db/schema.ts';

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
const CONFIGURE_AGENT_ACTION_KEY = 'core.identity.configure-agent';

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
      role('spravce', 'Správce', 'obchod@demo.ontos', 'Celá agenda pronájmů a správa lidí.', true),
      role('management', 'Vedení', 'management@siampark.demo', 'Přehledy, schvalování a správa lidí.', true),
      role('operations', 'Provoz', 'operations@siampark.demo', 'Majetek, prostory, úkoly a závady.'),
      role('sales', 'Obchod', 'obchodnik@demo.ontos', 'Nájemci, smlouvy a obchodní případy; faktury jen čte.'),
      role('finance', 'Účetní', 'finance@siampark.demo', 'Fakturace, platby a upomínky.'),
      role('external', 'Externí obchodník', 'external@siampark.demo', 'Jen svěřené kontakty a případy, bez financí.'),
    ],
    seeded: {
      'external@siampark.demo': 'external',
      'finance@siampark.demo': 'finance',
      'management@siampark.demo': 'management',
      'obchod@demo.ontos': 'spravce',
      'obchodnik@demo.ontos': 'sales',
      'operations@siampark.demo': 'operations',
      'ucetni@demo.ontos': 'finance',
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
  '71000000-0000-4000-8000-000000000024': {
    roles: [
      role('akrosAdmin', 'Správce e-shopu', 'eshop@akros.demo', 'Katalog, objednávky, zákazníci a správa lidí.', true),
      role('fulfilment', 'Expedice', 'expedice@akros.demo', 'Vyřizování a odesílání objednávek.'),
    ],
    seeded: { 'eshop@akros.demo': 'akrosAdmin', 'expedice@akros.demo': 'fulfilment' },
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

/** The company's roles with the principal of each role's template persona (module presets for agent entities). */
export const companyRoleTemplates = Effect.fn('DemoAccounts.companyRoleTemplates')(function* companyRoleTemplates(
  tenantId: string,
  legalEntityId: string,
) {
  const roles = rolesOf(legalEntityId);
  if (roles === undefined) {
    return [] as readonly { readonly key: string; readonly label: string; readonly templatePrincipalId: string }[];
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ email: user.email, principalId: coreBindings.principalId })
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
    .where(inArray(user.email, [...new Set(roles.roles.map((role) => role.templateEmail))]))
    .pipe(Effect.mapError(unavailable));
  const byEmail = new Map(rows.map((row) => [row.email, row.principalId]));
  return yield* Effect.forEach(roles.roles, (role) => {
    const templatePrincipalId = byEmail.get(role.templateEmail);
    return templatePrincipalId === undefined
      ? Effect.fail(new DemoAccountUnavailable({ cause: `Role template ${role.templateEmail} is not provisioned` }))
      : Effect.succeed({ key: role.key, label: role.label, templatePrincipalId });
  });
});

/** Administrative authorization is a live SpiceDB permission, never a persona label or job title. */
export const requireAdministrator = Effect.fn('DemoAccounts.requireAdministrator')(function* requireAdministrator(
  caller: DemoAccountCaller,
  grants: DemoAccountGrants,
) {
  const access = yield* ContextAccess;
  const { legalEntityId, principalId, tenantId } = caller.principal;
  const [tenant, company] = yield* Effect.all([
    access.tenants({ permission: 'manage_identity', principalId, tenantIds: [tenantId] }),
    access.legalEntities({ legalEntityIds: [legalEntityId], permission: 'manage_people', principalId, tenantId }),
  ]);
  if (![...tenant, ...company].some((decision) => decision.decision === 'allowed')) {
    return yield* new DemoAccountForbidden({ reason: 'Only a scoped administrator manages people' });
  }
  const members = yield* grants.companyMembers(tenantId, legalEntityId).pipe(Effect.mapError(unavailable));
  return { members };
});

/** Display names of principals by id (any kind: targets of agent audit rows are agent entities too). */
const principalNames = Effect.fn('DemoAccounts.principalNames')(function* principalNames(
  tenantId: string,
  principalIds: readonly string[],
) {
  if (principalIds.length === 0) {
    return new Map<string, string>();
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ displayName: corePrincipals.displayName, principalId: corePrincipals.principalId })
    .from(corePrincipals)
    .where(and(eq(corePrincipals.tenantId, tenantId), inArray(corePrincipals.principalId, [...principalIds])))
    .pipe(Effect.mapError(unavailable));
  return new Map(rows.map((row) => [row.principalId, row.displayName]));
});

/** Audit of the people (`subjects: 'people'`) or the agent entities (`subjects: 'agents'`) of one company. */
export const demoAccountAuditActionRows = (legalEntityId: string, subjects: 'agents' | 'people') =>
  and(
    eq(coreAuditEvents.legalEntityId, legalEntityId),
    sql`${coreAuditEvents.eventType} in ('action.executed', 'action.rejected')`,
    subjects === 'agents'
      ? or(
          sql`${coreAuditEvents.evidenceJson}->>'actionKey' = ${CONFIGURE_AGENT_ACTION_KEY}`,
          and(
            sql`${coreAuditEvents.evidenceJson}->>'actionKey' = ${ACTION_KEY}`,
            sql`${coreAuditEvents.evidenceJson}->>'principalKind' = 'agent'`,
          ),
        )
      : and(
          sql`${coreAuditEvents.evidenceJson}->>'actionKey' = ${ACTION_KEY}`,
          sql`coalesce(${coreAuditEvents.evidenceJson}->>'principalKind', 'human') <> 'agent'`,
        ),
  );

export const auditTrail = Effect.fn('DemoAccounts.auditTrail')(function* auditTrail(
  tenantId: string,
  legalEntityId: string,
  members: readonly string[],
  subjects: 'agents' | 'people',
) {
  const { executor } = yield* AuthDatabase;
  const actionRows = demoAccountAuditActionRows(legalEntityId, subjects);
  const otherRows =
    subjects === 'agents'
      ? and(
          eq(coreAuditEvents.legalEntityId, legalEntityId),
          eq(coreAuditEvents.eventType, 'identity.agent_operators_changed'),
        )
      : members.length === 0
        ? sql`false`
        : // Requests of deactivated accounts of this company, rejected and audited by the principal resolver.
          and(
            eq(coreAuditEvents.eventType, 'authn.rejected'),
            eq(coreAuditEvents.outcomeCode, 'principal_inactive'),
            inArray(coreAuditEvents.principalId, [...members]),
          );
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
    .where(and(eq(coreAuditEvents.tenantId, tenantId), or(actionRows, otherRows)))
    .orderBy(desc(coreAuditEvents.occurredAt))
    .limit(80)
    .pipe(Effect.mapError(unavailable));
  const entries = rows.map((row) => {
    const details: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(row.evidence)) {
      if (key !== 'actionKey' && key !== 'resultHash' && (typeof value === 'string' || value === null)) {
        details[key] = value;
      }
    }
    if (row.eventType === 'authn.rejected' && row.principalId !== null) {
      details['targetPrincipalId'] = row.principalId;
    }
    if (typeof details['targetPrincipalId'] !== 'string' && typeof details['agentPrincipalId'] === 'string') {
      details['targetPrincipalId'] = details['agentPrincipalId'];
    }
    return { details, row };
  });
  const targets = [
    ...new Set(
      entries.flatMap(({ details }) =>
        typeof details['targetPrincipalId'] === 'string' ? [details['targetPrincipalId']] : [],
      ),
    ),
  ];
  const names = yield* principalNames(tenantId, targets);
  return entries.map(({ details, row }) => {
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

/** Safe navigation hint: reveal no people or role records and keep actual list/write authorization unchanged. */
export const demoAccountCapability = Effect.fn('DemoAccounts.capability')(function* demoAccountCapability(
  caller: DemoAccountCaller,
) {
  const access = yield* ContextAccess;
  const { legalEntityId, principalId, tenantId } = caller.principal;
  const [tenant, company] = yield* Effect.all([
    access.tenants({ permission: 'read_people', principalId, tenantIds: [tenantId] }),
    access.legalEntities({ legalEntityIds: [legalEntityId], permission: 'read_people', principalId, tenantId }),
  ]);
  const canManage = [...tenant, ...company].some((decision) => decision.decision === 'allowed');
  return { canManage };
});

/** Deterministic IDs per idempotency key, so a retried create replays the same Core Action. */
export const derivedUuid = (seed: string) => {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** A non-administrator's attempt is denied before the Core Action runs; it is still written to the Core audit. */
export const auditForbiddenAttempt = (
  caller: DemoAccountCaller,
  operation: string,
  principalKind: 'agent' | null = null,
  targetPrincipalId: string | null = null,
) =>
  AuthDatabase.pipe(
    Effect.flatMap(({ executor }) =>
      executor.insert(coreAuditEventsWrite).values({
        auditProfile: 'sensitive',
        authBindingId: caller.principal.authBindingId ?? null,
        authMethod: caller.principal.authMethod,
        eventType: 'action.rejected',
        evidenceJson: {
          actionKey: ACTION_KEY,
          operation,
          principalKind,
          reason: 'company_administrator_required',
          ...(targetPrincipalId === null ? {} : { targetPrincipalId }),
        },
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
