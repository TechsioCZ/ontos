import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessPrincipalKind, GateCarrier, GateInput, GateMode } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import {
  preserveSystemPrincipalContextTrust,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { VerifiedGatewayActor } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { OperationalScope } from '@app/core-runtime/operations/context';
import { makeTestActionAccessPorts } from '@app/core-runtime/testing/actions';
import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { enrollRetailCustomerAction } from '../../src/actions/enroll-retail-customer.action.ts';
import { ownedRetailPartyResultRead } from '../../src/api/owned-retail-party-result.read.ts';
import { updateRetailCustomerProfileAction } from '../../src/actions/update-retail-customer-profile.action.ts';
import { retailCustomerProfileRead } from '../../src/api/retail-customer-profile.read.ts';

const TENANT = '00000000-0000-4000-8000-000000000001';
const SUBJECT = '00000000-0000-4000-8000-000000000002';
const COMPANY = '00000000-0000-4000-8000-000000000003';
const OTHER_COMPANY = '00000000-0000-4000-8000-000000000004';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000005';
const OTHER_PRINCIPAL = '00000000-0000-4000-8000-000000000006';
const REVISION = 'c'.repeat(64);
const STOREFRONT = 'commerce.storefront-client';
const workloadKinds: readonly AccessPrincipalKind[] = ['integration', 'service'];
const nonRunModes: readonly GateMode[] = ['approve', 'propose'];

const caller = (appId: string): VerifiedGatewayActor => ({
  appId,
  buildMarker: REVISION,
  principalId: '00000000-0000-4000-8000-000000000090',
});

interface ScopeInput {
  readonly actor?: VerifiedGatewayActor;
  readonly company?: string | null;
  readonly principalId?: string;
  readonly tenantId?: string;
}

/** A receiving gateway fixture seals provenance; a visible actor property alone never does. */
const scopeOf = (input: ScopeInput = {}): OperationalScope => {
  const subject = {
    authBindingId: '00000000-0000-4000-8000-000000000070',
    authContextRef: 'retail-directory-receiver-fixture',
    authMethod: 'api_key',
    principalId: input.principalId ?? SUBJECT,
    tenantId: input.tenantId ?? TENANT,
  };
  const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(
    input.company === null ? subject : { ...subject, legalEntityId: input.company ?? COMPANY },
  );
  const verified = trustVerifiedGatewayPrincipalContext(principal, REVISION, undefined, input.actor);
  return preserveSystemPrincipalContextTrust(verified, {
    ...verified,
    correlationId: 'retail-directory-access-test',
  });
};

interface GateFixture {
  readonly kind?: AccessPrincipalKind;
  readonly registryMissing?: boolean;
  readonly registeredCompanies?: readonly string[];
  readonly workloadKeys?: readonly string[];
}

/** Explicit fixture authority backs the shipped gate; no gate outcome is scripted. */
const gateOf = (input: GateFixture = {}) => {
  const source = makeTestActionAccessPorts({
    legalEntityIds: [COMPANY, OTHER_COMPANY],
    principalId: SUBJECT,
    tenantId: TENANT,
  });
  const ports = {
    authorityFor: source.intent.authorityFor,
    check: source.check,
    decisionLog: source.decisionLog,
    legalEntities: source.candidates,
    principalKinds: { readKind: () => Effect.succeed(Option.some(input.kind ?? 'integration')) },
  };
  if (input.registryMissing === true) {
    return makeAccessDecisionService(ports);
  }
  return makeAccessDecisionService({
    ...ports,
    workloadBindings: {
      readWorkloadAuthority: (query) => {
        const bound = query.principalId === SUBJECT && query.tenantId === TENANT;
        return Effect.succeed({
          activeCompanyIds: new Set(
            (bound ? (input.registeredCompanies ?? [COMPANY]) : []).map((id) => LegalEntityIdSchema.make(id)),
          ),
          workloadKeys: new Set(bound ? (input.workloadKeys ?? [STOREFRONT]) : []),
        });
      },
    },
  });
};

interface RetailEntrypoint {
  readonly carrier: GateCarrier;
  readonly legalEntityScope: GateInput['legalEntityScope'];
  readonly name: string;
}

const entrypoints: readonly RetailEntrypoint[] = [
  {
    carrier: enrollRetailCustomerAction.descriptor,
    legalEntityScope: enrollRetailCustomerAction.descriptor.legalEntityScope,
    name: 'retail customer enrollment',
  },
  {
    carrier: ownedRetailPartyResultRead.descriptor,
    legalEntityScope: ownedRetailPartyResultRead.descriptor.legalEntityScope,
    name: 'owned retail result recovery',
  },
  {
    carrier: retailCustomerProfileRead.descriptor,
    legalEntityScope: retailCustomerProfileRead.descriptor.legalEntityScope,
    name: 'own retail customer profile read',
  },
  {
    carrier: updateRetailCustomerProfileAction.descriptor,
    legalEntityScope: updateRetailCustomerProfileAction.descriptor.legalEntityScope,
    name: 'own retail customer profile update',
  },
];

const question = (entrypoint: RetailEntrypoint, scope: OperationalScope): GateInput => ({
  carrier: entrypoint.carrier,
  legalEntityScope: entrypoint.legalEntityScope,
  now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-20T00:00:00Z')),
  scope,
});

interface DeniedCase {
  readonly fixture?: GateFixture;
  readonly name: string;
  readonly scope: () => OperationalScope;
}

const deniedCases: readonly DeniedCase[] = [
  { name: 'CRM bringing a storefront subject', scope: () => scopeOf({ actor: caller('crm') }) },
  {
    fixture: { workloadKeys: ['demo.crm.party-intake'] },
    name: 'Commerce bringing a CRM intake subject',
    scope: () => scopeOf({ actor: caller('commerce-customer-context') }),
  },
  {
    fixture: { workloadKeys: ['demo.crm.party-intake'] },
    name: 'the existing CRM intake combination on this retail-only purpose',
    scope: () => scopeOf({ actor: caller('crm') }),
  },
  { name: 'another calling module', scope: () => scopeOf({ actor: caller('commerce-order') }) },
  {
    fixture: { kind: 'human' },
    name: 'a human subject with granted fixture capabilities',
    scope: () => scopeOf({ actor: caller('commerce-customer-context') }),
  },
  {
    fixture: { kind: 'agent' },
    name: 'an agent subject',
    scope: () => scopeOf({ actor: caller('commerce-customer-context') }),
  },
  {
    name: 'a direct storefront call without a module actor',
    scope: () => scopeOf(),
  },
  {
    fixture: { kind: 'human' },
    name: 'a direct human call despite granted fixture capabilities',
    scope: () => scopeOf(),
  },
  {
    name: 'visible but unverified caller metadata',
    scope: () => ({ ...scopeOf(), accessActor: caller('commerce-customer-context') }),
  },
  {
    fixture: { workloadKeys: [] },
    name: 'a revoked or absent storefront binding',
    scope: () => scopeOf({ actor: caller('commerce-customer-context') }),
  },
  {
    name: 'an integration principal without the registered binding',
    scope: () => scopeOf({ actor: caller('commerce-customer-context'), principalId: OTHER_PRINCIPAL }),
  },
  {
    name: 'an owned company outside this workload registration',
    scope: () => scopeOf({ actor: caller('commerce-customer-context'), company: OTHER_COMPANY }),
  },
  {
    name: 'another tenant carrying the original company and principal',
    scope: () => scopeOf({ actor: caller('commerce-customer-context'), tenantId: OTHER_TENANT }),
  },
  {
    name: 'a missing company scope',
    scope: () => scopeOf({ actor: caller('commerce-customer-context'), company: null }),
  },
];

for (const entrypoint of entrypoints) {
  it.effect(`${entrypoint.name} admits a verified Commerce caller with its bound storefront subject`, () =>
    Effect.gen(function* admitsBoundRetailDelegation() {
      for (const kind of workloadKinds) {
        const decision = yield* gateOf({ kind }).decide(
          question(entrypoint, scopeOf({ actor: caller('commerce-customer-context') })),
        );
        expect(decision.outcome).toBe('ALLOWED');
        expect(decision.reasons.map(({ code }) => code)).toContain('allow.workload');
      }
    }),
  );

  for (const control of deniedCases) {
    it.effect(`${entrypoint.name} rejects ${control.name}`, () =>
      Effect.gen(function* refusesNonRetailAuthority() {
        const decision = yield* gateOf(control.fixture).decide(question(entrypoint, control.scope()));
        expect(decision.outcome).toBe('DENIED');
      }),
    );
  }

  for (const mode of nonRunModes) {
    it.effect(`${entrypoint.name} rejects the ${mode} mode even for a bound Commerce delegation`, () =>
      Effect.gen(function* refusesNonRunModes() {
        const decision = yield* gateOf().decide({
          ...question(entrypoint, scopeOf({ actor: caller('commerce-customer-context') })),
          mode,
        });
        expect(decision.outcome).toBe('DENIED');
        expect(decision.reasons.map(({ code }) => code)).toContain('deny.mode_unsupported');
      }),
    );
  }

  it.effect(`${entrypoint.name} remains unavailable when no workload registry can be read`, () =>
    Effect.gen(function* refusesUnavailableRegistry() {
      const decision = yield* gateOf({ registryMissing: true }).decide(
        question(entrypoint, scopeOf({ actor: caller('commerce-customer-context') })),
      );
      expect(decision.outcome).toBe('UNAVAILABLE');
    }),
  );
}
