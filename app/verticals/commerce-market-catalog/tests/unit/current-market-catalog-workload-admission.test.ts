import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessPrincipalKind, AccessWorkloadBindings } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { currentMarketCatalogRead } from '../../src/api/current-market-catalog.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const storefrontWorkload = 'commerce.storefront-client';
const at = new Date('2030-06-01T00:00:00.000Z');

/** The trusted scope of a storefront BFF's direct API-key request: a service principal of one company. */
const storefrontScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '44444444-4444-4444-8444-444444444444',
    authContextRef: 'api-key:current-market-catalog',
    authMethod: 'api_key',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'current-market-catalog-workload-admission',
};

/** The carriers exactly as the read's own definition decoded them, never a hand-written stand-in. */
const carrier = {
  accessActor: currentMarketCatalogRead.descriptor.accessActor,
  accessDeclaration: currentMarketCatalogRead.descriptor.accessDeclaration,
  accessWorkload: currentMarketCatalogRead.descriptor.accessWorkload,
};

const question = (scope: typeof storefrontScope) => ({
  carrier,
  legalEntityScope: 'required' as const,
  now: at,
  scope,
});

/**
 * The native enforcement seam over a scripted principal kind and workload registry. Every port the
 * path under test must not reach fails the test when it is touched, so an admission cannot pass by
 * falling back to a human capability or a v2 engine check.
 */
const gateFor = (options: { readonly boundWorkloadKeys?: readonly string[]; readonly kind: AccessPrincipalKind }) => {
  const workloadBindings: AccessWorkloadBindings = {
    readWorkloadAuthority: () =>
      Effect.succeed({
        activeCompanyIds: new Set([LegalEntityIdSchema.make(legalEntityId)]),
        workloadKeys: new Set(options.boundWorkloadKeys),
      }),
  };
  return makeAccessDecisionService({
    authorityFor: () => ({
      readCells: () => Effect.die('Only a human decision reads authority cells'),
      readConnection: () => Effect.die('Only an agent decision reads a connection'),
      // A person who resolves no live membership scope is refused by the scope read itself.
      readScope: () => Effect.succeed(Option.none()),
      readTeamIds: () => Effect.die('Only a human decision reads team ids'),
    }),
    check: { checkBulk: () => Effect.die('A workload admission never asks the v2 engine') },
    decisionLog: { record: () => Effect.die('A workload decision is never a v2 evidence row') },
    legalEntities: { listCandidateIds: () => Effect.die('A workload admission never lists companies') },
    principalKinds: { readKind: () => Effect.succeed(Option.some(options.kind)) },
    workloadBindings,
  });
};

describe('Commerce Market Catalog current read workload admission', () => {
  it('declares the reviewed storefront workload beside the preserved human declaration and Pricing actor', () => {
    const { descriptor } = currentMarketCatalogRead;
    expect(descriptor.accessWorkload).toEqual({
      reason:
        'The registered Storefront BFF reads the current Market catalog for its own storefronts before any human session exists',
      workloads: [storefrontWorkload],
    });
    expect(descriptor.accessDeclaration).toMatchObject({
      key: 'commerce.market-catalog.market-catalog.read',
      kind: 'read',
      modes: ['run'],
      risk: 'routine',
    });
    expect(descriptor.accessActor).toMatchObject({ callers: ['pricing'], subject: 'identity' });
    expect(descriptor.accessActor?.subjectWorkloads).toBeUndefined();
    expect(descriptor.legalEntityScope).toBe('required');
  });

  it.effect('admits the service principal Core bound to the declared storefront workload', () =>
    Effect.gen(function* admitsBoundStorefront() {
      const decision = yield* gateFor({ boundWorkloadKeys: [storefrontWorkload], kind: 'service' }).decide(
        question(storefrontScope),
      );
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['allow.workload']);
    }),
  );

  it.effect('refuses an unregistered service principal on the same carrier', () =>
    Effect.gen(function* refusesUnregisteredService() {
      const decision = yield* gateFor({ kind: 'service' }).decide(question(storefrontScope));
      expect(decision.outcome).toBe('DENIED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_unbound']);
    }),
  );

  it.effect('refuses a service principal bound to a different registered workload key', () =>
    Effect.gen(function* refusesForeignWorkload() {
      const decision = yield* gateFor({ boundWorkloadKeys: ['demo.storefront-client'], kind: 'service' }).decide(
        question(storefrontScope),
      );
      expect(decision.outcome).toBe('DENIED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_unbound']);
    }),
  );

  it.effect('keeps a human caller on the declaration path and never reads the workload registry', () =>
    Effect.gen(function* keepsHumanOnDeclaration() {
      const decision = yield* gateFor({ kind: 'human' }).decide(question(storefrontScope));
      expect(decision.outcome).toBe('DENIED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.scope_mismatch']);
    }),
  );
});
