import { createHash } from 'node:crypto';

import {
  ContextAccess,
  IdentityAdministrationDeniedAudit,
  IdentityAdministrationAuditResultSchema,
  identityAdministrationAuditRead,
  ReadRuntime,
  staffRoleTemplateBindingsRead,
} from '@app/core-runtime';
import type { DemoAccountGrants, OperationalScopeRequest, TrustedPrincipalContext } from '@app/core-runtime';
import { Data, Effect, Predicate, Schema } from 'effect';

import { AgentActionRequestIdentity } from './agent-action-request-identity.ts';
import { DemoAccountUnavailable } from './demo-account-unavailable.ts';

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
const companyRoles = {
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
} satisfies Readonly<Record<string, CompanyRoles>>;

export class DemoAccountForbidden extends Data.TaggedError('DemoAccountForbidden')<{ readonly reason: string }> {}

const unavailable = (cause: unknown) => new DemoAccountUnavailable({ cause });
const fromReadError = (cause: { readonly _tag: string }) =>
  Predicate.isTagged(cause, 'ReadPermissionDenied') || Predicate.isTagged(cause, 'OperationContextDenied')
    ? new DemoAccountForbidden({ reason: 'Only a scoped administrator manages people' })
    : unavailable(cause);

export interface DemoAccountCaller {
  readonly legalName: string;
  readonly principal: TrustedPrincipalContext & { readonly legalEntityId: string };
}

const rolesOf = (legalEntityId: string): CompanyRoles | undefined =>
  Object.entries(companyRoles).find(([companyId]) => companyId === legalEntityId)?.[1];

export interface DemoRoleTemplate {
  readonly key: string;
  readonly label: string;
  readonly templatePrincipalId: string;
}

/** The original carrier and persisted read transport enter Core; role presets never establish authority. */
export const companyRoleTemplates = Effect.fn('DemoAccounts.companyRoleTemplates')(function* companyRoleTemplates(
  caller: DemoAccountCaller,
  transport: OperationalScopeRequest,
) {
  const roles = rolesOf(caller.principal.legalEntityId);
  if (roles === undefined) {
    const templates: readonly DemoRoleTemplate[] = [];
    return templates;
  }
  const runtime = yield* ReadRuntime;
  const { bindings } = yield* runtime
    .runRead({
      input: { emails: [...new Set(roles.roles.map((entry) => entry.templateEmail))] },
      principal: caller.principal,
      registration: staffRoleTemplateBindingsRead,
      transport,
    })
    .pipe(Effect.mapError(fromReadError));
  const byEmail = new Map(bindings.map((row) => [row.email, row.principalId]));
  return yield* Effect.forEach(
    roles.roles,
    (entry) => {
      const templatePrincipalId = byEmail.get(entry.templateEmail);
      return templatePrincipalId === undefined
        ? Effect.fail(new DemoAccountUnavailable({ cause: `Role template ${entry.templateEmail} is not provisioned` }))
        : Effect.succeed({ key: entry.key, label: entry.label, templatePrincipalId });
    },
    { concurrency: 1 },
  );
});

/** Administrative authorization is a live SpiceDB permission, never a persona label or job title. */
export const requireAdministrator = Effect.fn('DemoAccounts.requireAdministrator')(function* requireAdministrator(
  caller: DemoAccountCaller,
  grants: DemoAccountGrants,
) {
  const access = yield* ContextAccess;
  const { legalEntityId, principalId, tenantId } = caller.principal;
  const [tenant, company] = yield* Effect.all(
    [
      access.tenants({ permission: 'manage_identity', principalId, tenantIds: [tenantId] }),
      access.legalEntities({ legalEntityIds: [legalEntityId], permission: 'manage_people', principalId, tenantId }),
    ],
    { concurrency: 2 },
  );
  const decisions = [...tenant, ...company];
  if (!decisions.some((decision) => decision.decision === 'allowed')) {
    if (decisions.some((decision) => decision.decision === 'unavailable')) {
      return yield* unavailable('Company administration authorization is temporarily unavailable');
    }
    return yield* new DemoAccountForbidden({ reason: 'Only a scoped administrator manages people' });
  }
  const members = yield* grants.companyMembers(tenantId, legalEntityId).pipe(Effect.mapError(unavailable));
  return { members };
});

/** Audit scope and member/name lookup belong to the governed Core Read, never to transport-supplied IDs. */
export const auditTrail = Effect.fn('DemoAccounts.auditTrail')(function* auditTrail(
  caller: DemoAccountCaller,
  transport: OperationalScopeRequest,
  subjects: 'agents' | 'people',
) {
  const runtime = yield* ReadRuntime;
  const { entries } = yield* runtime
    .runRead({
      input: { subjects },
      principal: caller.principal,
      registration: identityAdministrationAuditRead,
      transport,
    })
    .pipe(Effect.mapError(fromReadError));
  const wire = yield* Schema.encodeEffect(IdentityAdministrationAuditResultSchema)({ entries }).pipe(
    Effect.mapError(unavailable),
  );
  return wire.entries;
});

/** Safe navigation hint: reveal no people or role records and keep actual list/write authorization unchanged. */
export const demoAccountCapability = Effect.fn('DemoAccounts.capability')(function* demoAccountCapability(
  caller: DemoAccountCaller,
) {
  const access = yield* ContextAccess;
  const { legalEntityId, principalId, tenantId } = caller.principal;
  const [tenant, company] = yield* Effect.all(
    [
      access.tenants({ permission: 'read_people', principalId, tenantIds: [tenantId] }),
      access.legalEntities({ legalEntityIds: [legalEntityId], permission: 'read_people', principalId, tenantId }),
    ],
    { concurrency: 2 },
  );
  const canManage = [...tenant, ...company].some((decision) => decision.decision === 'allowed');
  return { canManage };
});

/** Deterministic IDs per idempotency key, so a retried create replays the same Core Action. */
export const derivedUuid = (seed: string) => {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** A non-administrator's attempt is denied before the Core Action runs; it is still written to the Core audit. */
export const auditForbiddenAttempt = Effect.fn('DemoAccounts.auditForbiddenAttempt')(function* auditForbiddenAttempt(
  caller: DemoAccountCaller,
  operation: string,
  principalKind: 'agent' | null = null,
  targetPrincipalId: string | null = null,
) {
  const transport = yield* AgentActionRequestIdentity;
  const audit = yield* IdentityAdministrationDeniedAudit;
  yield* audit
    .record({ operation, principal: caller.principal, principalKind, targetPrincipalId, transport })
    .pipe(Effect.mapError(unavailable));
});
