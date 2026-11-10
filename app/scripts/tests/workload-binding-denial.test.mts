import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessDecisionPorts } from '../../packages/core-runtime/src/access/enforcement/contract.ts';
import { makeAccessDecisionService } from '../../packages/core-runtime/src/access/enforcement/service.ts';
import type { AccessPrincipalKind } from '../../packages/core-runtime/src/access/enforcement/actor.ts';
import type {
  AccessDeclaration,
  AccessWorkload,
} from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import {
  AccessKeySchema,
  WorkloadKeySchema,
} from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import type { OperationalScope } from '../../packages/core-runtime/src/operations/context.ts';
import { LegalEntityIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import {
  IDENTITY_PROVIDER_WORKLOAD,
  CRM_PARTY_INTAKE_WORKLOAD,
  STOREFRONT_CLIENT_WORKLOAD,
  agentBotPrincipal,
  akrosStorefrontPrincipal,
  commercePortalPrincipal,
  crmPartyIntakePrincipal,
  demoHumanAccounts,
  reviewedWorkloadBindings,
  storefrontPrincipal,
} from '../demo/permissions.mts';
import { demoTenantId } from '../demo/fixture-ids.mts';

/*
 * The registered workload rule, proved against the real enforcement seam (O73). The reviewed demo bindings
 * are the registry the gate reads, and every question below is answered by `makeAccessDecisionService`
 * itself — not by a scripted double — so the test proves what the demo actually ships:
 *
 *  - a service principal is admitted only on a carrier that declares one of its bound keys;
 *  - an unrelated declared key, a declaration carrier and an unbound principal are all refused;
 *  - a person is never admitted on a workload carrier;
 *  - the registry answers only the request's own tenant, so a binding never crosses a tenant.
 */
const foreignTenantId = '70000000-0000-4000-8000-000000000099';
const workloadUnbound = 'deny.workload_unbound';
const OTHER_WORKLOAD = WorkloadKeySchema.make('commerce.other-client');
const storefrontCarrier: AccessWorkload = {
  reason: 'The shared Storefront client starts an enrollment on a visitor behalf',
  workloads: [WorkloadKeySchema.make(STOREFRONT_CLIENT_WORKLOAD)],
};
const identityProviderCarrier: AccessWorkload = {
  reason: 'The external identity provider resolves the binding of the subject it is admitting',
  workloads: [WorkloadKeySchema.make(IDENTITY_PROVIDER_WORKLOAD)],
};
const unrelatedCarrier: AccessWorkload = {
  reason: 'A carrier no reviewed workload declares',
  workloads: [OTHER_WORKLOAD],
};

const machineKinds = new Map<string, AccessPrincipalKind>([
  [storefrontPrincipal.principalId, 'service'],
  [akrosStorefrontPrincipal.principalId, 'service'],
  [commercePortalPrincipal.principalId, 'service'],
  [crmPartyIntakePrincipal.principalId, 'service'],
  [agentBotPrincipal.principalId, 'service'],
]);
const kindOf = (principalId: string): Option.Option<AccessPrincipalKind> =>
  machineKinds.get(principalId) === undefined
    ? Option.some('human')
    : Option.some(machineKinds.get(principalId) ?? 'service');

/** The reviewed bindings as the registry: only this tenant's rows, exactly as the Drizzle reader answers. */
const boundKeysOf = (tenantId: string, principalId: string): ReadonlySet<string> =>
  new Set(
    tenantId === demoTenantId
      ? reviewedWorkloadBindings()
          .filter((binding) => binding.principalId === principalId)
          .map((binding) => binding.workloadKey)
      : [],
  );

const scopeOf = (principalId: string, tenantId: string = demoTenantId): OperationalScope => ({
  authBindingId: `fixture-binding-${principalId}`,
  authContextRef: `fixture:${principalId}`,
  authMethod: 'api_key',
  correlationId: 'workload-binding-denial',
  legalEntityId: '71000000-0000-4000-8000-000000000020',
  principalId,
  tenantId,
});

const ports: AccessDecisionPorts = {
  authorityFor: () => ({
    readCells: () => Effect.succeed([]),
    readConnection: () => Effect.succeed(Option.none()),
    readScope: () => Effect.succeed(Option.none()),
    readTeamIds: () => Effect.succeed([]),
  }),
  check: { checkBulk: () => Effect.succeed([]) },
  decisionLog: { record: () => Effect.void },
  legalEntities: { listCandidateIds: () => Effect.succeed([]) },
  principalKinds: { readKind: (query) => Effect.succeed(kindOf(query.principalId)) },
  workloadBindings: {
    readActiveWorkloadKeys: (query) => Effect.succeed(boundKeysOf(query.tenantId, query.principalId)),
    readCompanyDeclaration: () =>
      Effect.succeed({
        activeCompanyIds: new Set([LegalEntityIdSchema.make('71000000-0000-4000-8000-000000000020')]),
        pinned: true,
      }),
  },
};

const gate = makeAccessDecisionService(ports);

const declarationFor = (key: string): AccessDeclaration => ({
  key: AccessKeySchema.make(key),
  kind: 'action' as const,
  modes: ['run' as const],
  placement: { group: 'fixtures', level: 'basic' as const },
  risk: 'sensitive' as const,
  selectors: [],
});
const decideOn = (
  principalId: string,
  accessWorkload: AccessWorkload | undefined,
  options: { readonly accessDeclaration?: { readonly key: string }; readonly tenantId?: string } = {},
) => {
  const question = {
    legalEntityScope: 'required' as const,
    now: new Date(0),
    scope: scopeOf(principalId, options.tenantId),
  };
  if (accessWorkload === undefined) {
    if (options.accessDeclaration === undefined) {
      return Effect.die('The fixture requires a declared workload or capability');
    }
    return gate.decide({ ...question, carrier: { accessDeclaration: declarationFor(options.accessDeclaration.key) } });
  }
  if (options.accessDeclaration === undefined) {
    return gate.decide({ ...question, carrier: { accessWorkload } });
  }
  return gate.decide({
    ...question,
    carrier: { accessDeclaration: declarationFor(options.accessDeclaration.key), accessWorkload },
  });
};

const codesOf = (decision: { readonly reasons: readonly { readonly code: string }[] }): readonly string[] =>
  decision.reasons.map(({ code }) => code);

it.effect('admits a storefront principal on the carrier that declares its bound key', () =>
  Effect.gen(function* admitsBoundStorefront() {
    const decision = yield* decideOn(storefrontPrincipal.principalId, storefrontCarrier);
    expect(decision.outcome).toBe('ALLOWED');
    expect(codesOf(decision)).toEqual(['allow.workload']);
  }),
);

it.effect('admits the portal on both of its declared keys, and the AKROS storefront on its own', () =>
  Effect.gen(function* admitsEachDeclaredKey() {
    expect((yield* decideOn(commercePortalPrincipal.principalId, storefrontCarrier)).outcome).toBe('ALLOWED');
    expect((yield* decideOn(commercePortalPrincipal.principalId, identityProviderCarrier)).outcome).toBe('ALLOWED');
    expect((yield* decideOn(akrosStorefrontPrincipal.principalId, storefrontCarrier)).outcome).toBe('ALLOWED');
  }),
);

it.effect('refuses a storefront on a declared key it is not bound for', () =>
  Effect.gen(function* refusesUnboundKey() {
    const decision = yield* decideOn(storefrontPrincipal.principalId, unrelatedCarrier);
    expect(decision.outcome).toBe('DENIED');
    expect(codesOf(decision)).toEqual([workloadUnbound]);
  }),
);

it.effect('refuses a service principal on a declaration carrier, never admitting it as a person', () =>
  Effect.gen(function* refusesServiceOnDeclaration() {
    const decision = yield* decideOn(storefrontPrincipal.principalId, undefined, {
      accessDeclaration: { key: 'demo.merchandise.apply-command.write' },
    });
    expect(decision.outcome).toBe('DENIED');
    expect(codesOf(decision)).toEqual(['deny.workload_forbidden']);
  }),
);

it.effect('refuses a person on a workload carrier, so the workload path never widens to people', () =>
  Effect.gen(function* refusesHumanOnWorkload() {
    const decision = yield* decideOn(demoHumanAccounts[0].principalId, storefrontCarrier);
    expect(decision.outcome).toBe('DENIED');
    expect(codesOf(decision)).toEqual(['deny.workload_only']);
  }),
);

it.effect('refuses other machine identities on the storefront key they do not hold', () =>
  Effect.gen(function* refusesUnboundMachines() {
    for (const principalId of [crmPartyIntakePrincipal.principalId, agentBotPrincipal.principalId]) {
      const decision = yield* decideOn(principalId, storefrontCarrier);
      expect({ outcome: decision.outcome, principalId }).toEqual({ outcome: 'DENIED', principalId });
      expect(codesOf(decision)).toEqual([workloadUnbound]);
    }
  }),
);

it.effect("keeps a binding inside its own tenant: another tenant holds none of this principal's keys", () =>
  Effect.gen(function* refusesForeignTenant() {
    const decision = yield* decideOn(storefrontPrincipal.principalId, storefrontCarrier, {
      tenantId: foreignTenantId,
    });
    expect(decision.outcome).toBe('DENIED');
    expect(codesOf(decision)).toEqual([workloadUnbound]);
    // The registry the demo seeds names exactly one tenant, so the refusal above is the contract, not a stub.
    expect(boundKeysOf(demoTenantId, storefrontPrincipal.principalId)).toEqual(new Set([STOREFRONT_CLIENT_WORKLOAD]));
    expect(boundKeysOf(foreignTenantId, storefrontPrincipal.principalId).size).toBe(0);
  }),
);

it.effect('admits the reviewed CRM intake only on its purpose workload, not broad declaration carriers', () =>
  Effect.gen(function* exactCrmIntakeWorkload() {
    const carrier: AccessWorkload = {
      reason: 'Reviewed CRM intake purpose',
      workloads: [WorkloadKeySchema.make(CRM_PARTY_INTAKE_WORKLOAD)],
    };
    expect((yield* decideOn(crmPartyIntakePrincipal.principalId, carrier)).outcome).toBe('ALLOWED');
    expect((yield* decideOn(storefrontPrincipal.principalId, carrier)).outcome).toBe('DENIED');
    expect((yield* decideOn(demoHumanAccounts[0].principalId, carrier)).outcome).toBe('DENIED');
    expect(
      (yield* decideOn(crmPartyIntakePrincipal.principalId, carrier, {
        tenantId: foreignTenantId,
      })).outcome,
    ).toBe('DENIED');
    for (const key of ['demo.crm.api-records.read', 'demo.crm.apply-command.write', 'party.registry.party.create']) {
      const denied = yield* decideOn(crmPartyIntakePrincipal.principalId, undefined, { accessDeclaration: { key } });
      expect(denied.outcome).toBe('DENIED');
      expect(codesOf(denied)).toEqual(['deny.workload_forbidden']);
    }
  }),
);
