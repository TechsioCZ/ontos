import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { requireOrderFinalizationWorker } from '../../src/services/order-commitment.service.ts';
import {
  buyerPrincipalId,
  impersonatingPrincipalId,
  moduleActor,
  verifiedScope,
} from '../support/verified-gateway-scope.ts';

const workerPrincipalId = '20000000-0000-4000-8000-000000000001';
const commerceOrderActor = moduleActor('commerce-order', workerPrincipalId);
const scope = verifiedScope;

// Pure admission tests use Core's explicit provenance seam. Genuine assertion issuance, signatures and
// the accessActor gate are integration gates. The subject here is the buyer; the actor is the module.
describe('Order completion worker admission', () => {
  it.effect('does not turn matching raw fields into a verified calling module', () =>
    Effect.gen(function* rejectRawFields() {
      const failure = yield* requireOrderFinalizationWorker(
        scope({}, { actor: commerceOrderActor, verified: false }),
      ).pipe(Effect.flip);
      expect(failure.code).toBe('order_commitment_permission_denied');
    }),
  );
  it.effect('does not admit a verified buyer session that names no calling module', () =>
    Effect.gen(function* rejectBuyerSession() {
      const failure = yield* requireOrderFinalizationWorker(
        scope({ authContextRef: 'better-auth-session:buyer', authMethod: 'session' }),
      ).pipe(Effect.flip);
      expect(failure.code).toBe('order_commitment_permission_denied');
    }),
  );
  it.effect('does not admit another module acting for the buyer', () =>
    Effect.gen(function* rejectOtherModule() {
      const failure = yield* requireOrderFinalizationWorker(
        scope({}, { actor: { ...commerceOrderActor, appId: 'commerce-customer-context' } }),
      ).pipe(Effect.flip);
      expect(failure.code).toBe('order_commitment_permission_denied');
    }),
  );
  it.effect('admits a delegated call made for an impersonated buyer; the subject stays the buyer', () =>
    Effect.gen(function* admitImpersonatedSubject() {
      expect(
        yield* requireOrderFinalizationWorker(
          scope(
            {
              authMethod: 'support_impersonation',
              impersonatedByPrincipalId: impersonatingPrincipalId,
              principalId: buyerPrincipalId,
            },
            { actor: commerceOrderActor },
          ),
        ),
      ).toBe(workerPrincipalId);
    }),
  );
  it.effect('admits Order acting as the worker and returns its service principal, never the buyer', () =>
    Effect.gen(function* admitCommerceOrderActor() {
      expect(yield* requireOrderFinalizationWorker(scope({}, { actor: commerceOrderActor }))).toBe(workerPrincipalId);
    }),
  );
});
