import type { OperationalScope } from '@app/core-runtime';
import { Effect, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { measureOf } from './support/privacy-owner-fixtures.ts';
import {
  failClosedPrivacyOwnerInputs,
  productionPrivacyOwnerInputSource,
} from '../../src/services/privacy-owner-inputs.ts';
import { assessCategoryConfiguration, communicationsOwnDataInventory } from '../../shared/privacy-owner/inventory.ts';

/**
 * [audit T3-21, T3-24; R-D11; #1410 D.4 "Privacy inputs are supplied, never invented"] Both owner Reads obtain the Privacy inputs
 * through ONE source. Until an owner supplies them it is the explicit fail-closed form.
 */
const scope: OperationalScope = {
  authContextRef: 'job:communications-privacy-inputs-tests:run:1',
  authMethod: 'system',
  correlationId: 'communications-privacy-inputs-tests',
  principalId: '00000000-0000-4000-8000-0000000000b1',
  tenantId: '00000000-0000-4000-8000-0000000000a1',
};

describe('The Privacy inputs of the owner Reads come from one source that fails closed until an owner supplies them', () => {
  it('supplies no Privacy reference, no eligibility, no backup evaluation and no transport key', () => {
    const { coverage } = productionPrivacyOwnerInputSource(scope);
    expect(coverage.supplied).toEqual({});
    expect(coverage.eligibility).toEqual({});
    expect(coverage.backup).toEqual({ kind: 'UNAVAILABLE' });
    expect(coverage.currentTransportProviderKey).toBeUndefined();
  });

  it('leaves every persisted category a CONFIGURATION_GAP, so no retention period is ever assumed', () => {
    const { coverage } = productionPrivacyOwnerInputSource(scope);
    const states = communicationsOwnDataInventory.map(
      (category) => assessCategoryConfiguration(category, coverage.supplied[category.id]).state,
    );
    expect(states.filter((state) => state !== 'NOT_APPLICABLE').every((state) => state === 'CONFIGURATION_GAP')).toBe(
      true,
    );
  });

  it.effect(
    'assesses no blocker and supplies no enforcement signal: a hold is never assumed absent, nothing is assumed enforced',
    () =>
      Effect.gen(function* failClosedFacts() {
        const { execution } = failClosedPrivacyOwnerInputs;
        expect(Option.isNone(yield* execution.blockers(measureOf()))).toBe(true);
        expect(Option.isNone(yield* execution.enforcement(measureOf()))).toBe(true);
      }),
  );
});
