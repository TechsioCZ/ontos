import { AccessDeclarationSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { TenantIntentLoader } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { DateTime, Effect, Option, Schema, Struct } from 'effect';
import type { LookupAccess } from '../../shared/apis/records.ts';

// Exact operations used by the Work pickers. Their declarations come from Core's published catalog,
// never copied metadata or another deployment's private registration.
const lookupCapabilities = {
  contracts: { key: 'legal.agreements.api-records.read', moduleKey: 'legal.agreements' },
  customers: { key: 'party.registry.customer.list', moduleKey: 'party.registry' },
  opportunities: { key: 'demo.sales-pipeline.api-records.read', moduleKey: 'demo.sales-pipeline' },
  properties: { key: 'property.portfolio.api-records.read', moduleKey: 'property.portfolio' },
} as const;
const unavailable: LookupAccess = {
  contracts: 'unavailable',
  customers: 'unavailable',
  opportunities: 'unavailable',
  properties: 'unavailable',
};

/** Hints only. The owner still authorizes every lookup, including its row and field projection. */
export const taskLookupAccess = Effect.fn('Work.taskLookupAccess')(function* taskLookupAccess(scope: OperationalScope) {
  if (scope.legalEntityId === undefined) {
    return unavailable;
  }
  const loader = yield* TenantIntentLoader;
  const intent = yield* loader.loadProjection(scope).pipe(Effect.option);
  if (Option.isNone(intent)) {
    return unavailable;
  }
  const gate = yield* AccessDecisionGate;
  const now = yield* DateTime.nowAsDate;
  const check = Effect.fn('Work.lookupCapability')(function* check(name: keyof LookupAccess) {
    const wanted = lookupCapabilities[name];
    const entry = intent.value.catalogEntries.find(
      ({ key, moduleKey }) => key === wanted.key && moduleKey === wanted.moduleKey,
    );
    if (entry === undefined || entry.kind !== 'read') {
      return 'unavailable' as const;
    }
    const declaration = yield* Schema.decodeUnknownEffect(AccessDeclarationSchema)(
      Struct.omit(entry, ['moduleKey', 'parentKey']),
    ).pipe(Effect.option);
    if (Option.isNone(declaration)) {
      return 'unavailable' as const;
    }
    const question = {
      carrier: { accessDeclaration: declaration.value },
      legalEntityScope: 'required' as const,
      now,
      scope,
    };
    const listing = declaration.value.selectors.length > 0 ? yield* gate.list(question) : undefined;
    if (listing?.decision.outcome === 'ALLOWED' && listing.predicate === undefined) {
      return 'unavailable' as const;
    }
    const decision = listing?.decision ?? (yield* gate.decide(question));
    if (decision.outcome === 'ALLOWED') {
      return 'allowed' as const;
    }
    return decision.outcome === 'UNAVAILABLE' ? ('unavailable' as const) : ('denied' as const);
  });
  return yield* Effect.all(
    {
      contracts: check('contracts'),
      customers: check('customers'),
      opportunities: check('opportunities'),
      properties: check('properties'),
    },
    { concurrency: 1 },
  );
});
