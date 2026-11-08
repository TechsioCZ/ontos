import { withOptional } from '../../src/access/decision/optional.ts';
import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import { LegalEntityIdSchema } from '../../src/access/ids.ts';
import type { AccessScope } from '../../src/access/model.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeAccessDeclaration } from '../../src/authorization/access-declaration.ts';
import { companyManagedPrincipalsRead, managedPrincipalsRead } from '../../src/auth/principal-administration-reads.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { at, makeAuthority, makeCheck, person, scopeId, tenant } from './access-decision-support.ts';

/**
 * The two managed-key reads are one owner implementation with two canonical carriers (O7, O28): the
 * tenant-managed list is decided in the tenant context, and the company-agent list in the exact named
 * company. These cases run the real decision engine over faked ports, so the scope each read is
 * decided in is the engine's own behaviour and not a scripted answer.
 */

const companyA = '00000000-0000-4000-8000-000000000101';
const companyB = '00000000-0000-4000-8000-000000000102';

const tenantScope: AccessScope = { _tag: 'TenantContext', tenantId: tenant };
const companyScope = (legalEntityId: string): AccessScope => ({
  _tag: 'LegalEntity',
  legalEntityId: LegalEntityIdSchema.make(legalEntityId),
  tenantId: tenant,
});

/** A company administrator: an access admin of exactly these companies and no tenant context. */
const companyAdminBasis = (legalEntityIds: readonly string[]): AccessConfigureBasis => ({
  _tag: 'ScopeAdmin',
  legalEntityIds: legalEntityIds.map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId)),
  tenantContext: false,
});

/** The tenant's own owner: the whole tenant, so every context inside it. */
const ownerBasis: AccessConfigureBasis = { _tag: 'Owner' };

const operationalScope = (legalEntityId?: string): OperationalScope =>
  Object.freeze({
    ...Schema.decodeSync(TrustedPrincipalContextSchema)(
      withOptional(
        {
          authBindingId: '00000000-0000-4000-8000-000000000009',
          authContextRef: 'better-auth-session:managed-principals-read',
          authMethod: 'session',
          principalId: person,
          tenantId: tenant,
        },
        'legalEntityId',
        legalEntityId,
      ),
    ),
    correlationId: 'managed-principals-read-correlation',
  });

const gateFor = (input: {
  readonly bases: readonly AccessConfigureBasis[];
  readonly legalEntityScope: AccessScope;
}): BoundAccessGate => {
  const spec = {
    cells: [],
    configureBases: input.bases,
    legalEntityScope: input.legalEntityScope,
    resolvedScopeId: scopeId,
  } as const;
  const authority = makeAuthority(spec);
  const check = makeCheck({ authority: spec });
  const ports = {
    candidates: { listCandidateIds: () => Effect.succeed([]) },
    check: check.port,
    decisionLog: { record: () => Effect.void },
    intent: { authorityFor: () => authority.port },
    principalKinds: { readKind: () => Effect.succeed(Option.some('human' as const)) },
  };
  return bindAccessGate(
    makeAccessDecisionService({
      authorityFor: ports.intent.authorityFor,
      check: ports.check,
      decisionLog: ports.decisionLog,
      legalEntities: ports.candidates,
      principalKinds: ports.principalKinds,
    }),
    ports,
  );
};

type ManagedPrincipalRead = typeof managedPrincipalsRead | typeof companyManagedPrincipalsRead;

const carrierOf = (registration: ManagedPrincipalRead) => ({
  accessDeclaration: Result.getOrThrow(
    decodeAccessDeclaration(registration.descriptor.accessDeclaration, registration.descriptor.entrypoint),
  ),
});

const decide = (
  registration: ManagedPrincipalRead,
  gate: BoundAccessGate,
  principal: OperationalScope,
): Effect.Effect<string> =>
  gate
    .decide({
      carrier: carrierOf(registration),
      legalEntityScope: registration.descriptor.legalEntityScope,
      now: at('2026-11-03T09:00:00Z'),
      scope: principal,
    })
    .pipe(Effect.map((decision) => decision.outcome));

it('declares both managed-key carriers as protected admin reads with their own exact field groups', () => {
  const tenantDescriptor = managedPrincipalsRead.descriptor;
  const companyDescriptor = companyManagedPrincipalsRead.descriptor;

  // Tenant-managed: decided in the tenant context, so its entrypoint's scope is optional.
  expect(tenantDescriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(tenantDescriptor.legalEntityScope).toBe('optional');
  expect(tenantDescriptor.accessDeclaration).toMatchObject({
    key: 'core.identity.principal.list-managed',
    kind: 'admin',
    modes: ['run'],
    risk: 'sensitive',
  });
  expect(tenantDescriptor.accessFieldGroups?.map((group) => [group.key, group.fieldClass, group.kind])).toEqual([
    ['core.identity.principal.read-personal-data', 'personal_data', 'field_read'],
    ['core.identity.principal.read-authentication-metadata', 'authentication_metadata', 'field_read'],
  ]);

  // Company-agent: decided in the exact named company, so its entrypoint's scope is required.
  expect(companyDescriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(companyDescriptor.legalEntityScope).toBe('required');
  expect(companyDescriptor.accessDeclaration).toMatchObject({
    key: 'core.identity.company-agent-key.list-managed',
    kind: 'admin',
    modes: ['run'],
    risk: 'sensitive',
  });
  expect(companyDescriptor.accessFieldGroups?.map((group) => [group.key, group.fieldClass, group.kind])).toEqual([
    ['core.identity.company-agent-key.read-personal-data', 'personal_data', 'field_read'],
    ['core.identity.company-agent-key.read-authentication-metadata', 'authentication_metadata', 'field_read'],
  ]);

  // Two carriers, never one shared key: a company administrator never inherits the tenant key.
  expect(companyDescriptor.accessDeclaration?.key).not.toBe(tenantDescriptor.accessDeclaration?.key);
});

it.effect('admits a company administrator in their own company and refuses another company', () =>
  Effect.gen(function* companyAdminScope() {
    const gate = gateFor({ bases: [companyAdminBasis([companyA])], legalEntityScope: companyScope(companyA) });
    expect(yield* decide(companyManagedPrincipalsRead, gate, operationalScope(companyA))).toBe('ALLOWED');

    const otherCompany = gateFor({
      bases: [companyAdminBasis([companyA])],
      legalEntityScope: companyScope(companyB),
    });
    expect(yield* decide(companyManagedPrincipalsRead, otherCompany, operationalScope(companyB))).toBe('DENIED');
  }),
);

it.effect('refuses a company administrator the tenant-managed list and a company-less company read', () =>
  Effect.gen(function* tenantAdministrationRefused() {
    // The tenant-managed carrier runs in the tenant context; a company admin has no tenant context.
    const tenantGate = gateFor({ bases: [companyAdminBasis([companyA])], legalEntityScope: tenantScope });
    expect(yield* decide(managedPrincipalsRead, tenantGate, operationalScope())).toBe('DENIED');

    // The company-agent carrier names one company; without one the engine refuses the scope itself.
    const companyGate = gateFor({ bases: [companyAdminBasis([companyA])], legalEntityScope: companyScope(companyA) });
    expect(yield* decide(companyManagedPrincipalsRead, companyGate, operationalScope())).toBe('DENIED');
  }),
);

it.effect('keeps the tenant owner able to read both carriers', () =>
  Effect.gen(function* tenantOwnerStillWorks() {
    const tenantGate = gateFor({ bases: [ownerBasis], legalEntityScope: tenantScope });
    expect(yield* decide(managedPrincipalsRead, tenantGate, operationalScope())).toBe('ALLOWED');

    const companyGate = gateFor({ bases: [ownerBasis], legalEntityScope: companyScope(companyA) });
    expect(yield* decide(companyManagedPrincipalsRead, companyGate, operationalScope(companyA))).toBe('ALLOWED');
  }),
);
