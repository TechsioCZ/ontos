import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { committedEvidenceVerifier } from '../../src/api/committed-order-approval-evidence.read.ts';
import { preparedApprovalVerifier } from '../../src/api/prepared-order-approval-binding.read.ts';
import { preparedPricingVerifier } from '../../src/api/prepared-order-pricing-binding.read.ts';
import {
  buyerPrincipalId,
  impersonatingPrincipalId,
  moduleActor,
  verifiedScope,
} from '../support/verified-gateway-scope.ts';

// Each verifier admits one verified calling module, whatever the subject; the subject is checked by the
// persistence read it guards. Raw matching fields never stand in for Shell-verified provenance.
const verifiers = [
  {
    admitted: 'pricing',
    denied: 'commerce-customer-context',
    name: 'prepared Order pricing binding',
    verify: preparedPricingVerifier,
  },
  {
    admitted: 'commerce-customer-context',
    denied: 'pricing',
    name: 'prepared Order approval binding',
    verify: preparedApprovalVerifier,
  },
  {
    admitted: 'commerce-customer-context',
    denied: 'pricing',
    name: 'committed Order approval evidence',
    verify: committedEvidenceVerifier,
  },
] as const;

for (const { admitted, denied, name, verify } of verifiers) {
  describe(`Order ${name} verifier`, () => {
    it.effect(`admits the verified ${admitted} module acting for the buyer`, () =>
      Effect.gen(function* admitVerifiedModule() {
        yield* verify(verifiedScope({}, { actor: moduleActor(admitted) }));
      }),
    );
    it.effect(`admits ${admitted} acting for an impersonated buyer`, () =>
      Effect.gen(function* admitImpersonatedSubject() {
        yield* verify(
          verifiedScope(
            {
              authMethod: 'support_impersonation',
              impersonatedByPrincipalId: impersonatingPrincipalId,
              principalId: buyerPrincipalId,
            },
            { actor: moduleActor(admitted) },
          ),
        );
      }),
    );
    it.effect(`denies another module (${denied}) acting for the buyer`, () =>
      Effect.gen(function* denyOtherModule() {
        const failure = yield* verify(verifiedScope({}, { actor: moduleActor(denied) })).pipe(Effect.flip);
        expect(failure.code).toBe('read_permission_denied');
      }),
    );
    it.effect('denies a verified subject that names no calling module', () =>
      Effect.gen(function* denyNoActor() {
        const failure = yield* verify(verifiedScope()).pipe(Effect.flip);
        expect(failure.code).toBe('read_permission_denied');
      }),
    );
    it.effect('denies matching raw fields that were never verified', () =>
      Effect.gen(function* denyUnverified() {
        const failure = yield* verify(verifiedScope({}, { actor: moduleActor(admitted), verified: false })).pipe(
          Effect.flip,
        );
        expect(failure.code).toBe('read_permission_denied');
      }),
    );
  });
}
