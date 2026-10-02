import {
  PricingMaterialChangedSchema,
  PricingMaterialChangeUnverifiableSchema,
  PricingNonMaterialSchema,
  PricingOwnerConfirmedNonMaterialSchema,
} from '@app/pricing-contracts/domain/material-change';
import type {
  PricingMaterialChangeClassification,
  PricingMaterialStateSnapshot,
} from '@app/pricing-contracts/domain/material-change';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { classifyPricingMaterialChange } from '../../src/services/material-change-classification.service.ts';
import {
  makeIssue787OwnerTransition,
  makeIssue787Snapshot,
  makeIssue787SourceEvidence,
} from './support/issue-787-material-change.fixture.ts';

const request = (
  previous: PricingMaterialStateSnapshot,
  current: PricingMaterialStateSnapshot,
  ownerTransitions: Parameters<typeof classifyPricingMaterialChange>[0]['ownerTransitions'] = [],
) => ({ current, ownerTransitions, previous });

const expectNonMaterial = (result: PricingMaterialChangeClassification, reason: string) => {
  expect(Schema.is(PricingNonMaterialSchema)(result)).toBe(true);
  if (Schema.is(PricingNonMaterialSchema)(result)) {
    expect(result.reason).toBe(reason);
  }
};

const expectMaterial = (result: PricingMaterialChangeClassification, reasons: readonly string[]) => {
  expect(Schema.is(PricingMaterialChangedSchema)(result)).toBe(true);
  if (Schema.is(PricingMaterialChangedSchema)(result)) {
    expect(result.reasons).toEqual(expect.arrayContaining([...reasons]));
  }
};

describe('Pricing material-change classification', () => {
  it('classifies exact material state and Storefront/Tax-only observations as non-material', () => {
    const previous = makeIssue787Snapshot();
    const exact = makeIssue787Snapshot({ attemptId: 'attempt-exact', snapshotId: 'snapshot-exact' });
    const storefrontOnly = {
      ...exact,
      nonMaterialObservations: [
        { kind: 'STOREFRONT_ORIGIN' as const, observationRef: 'storefront:brand-b' },
        { kind: 'TAX_ONLY' as const, observationRef: 'tax:revision-10' },
      ],
      snapshotId: 'snapshot-storefront-only',
    };

    expectNonMaterial(classifyPricingMaterialChange(request(previous, exact)), 'EXACT_MATERIAL_STATE');
    expectNonMaterial(classifyPricingMaterialChange(request(previous, storefrontOnly)), 'STOREFRONT_OR_TAX_ONLY');
  });

  it('requires exact owner evidence before accepting a meaning-preserving proof transition', () => {
    const previous = makeIssue787Snapshot();
    const current = makeIssue787Snapshot({ attemptId: 'attempt-2', revision: '2', snapshotId: 'snapshot-2' });

    expectMaterial(classifyPricingMaterialChange(request(previous, current)), ['EXACT_PRICE_KEY_OR_SET_CHANGED']);
    const confirmed = classifyPricingMaterialChange(
      request(previous, current, [makeIssue787OwnerTransition(previous, current)]),
    );
    expect(Schema.is(PricingOwnerConfirmedNonMaterialSchema)(confirmed)).toBe(true);
    if (Schema.is(PricingOwnerConfirmedNonMaterialSchema)(confirmed)) {
      expect(confirmed.transitions).toMatchObject([{ bindingRef: 'binding:price:line-a' }]);
    }
  });

  it('never lets owner transition evidence hide Price insertion, collision, or a crossed boundary', () => {
    const absent = makeIssue787Snapshot({ meaningRef: 'meaning:price:absent', sourceState: 'ABSENT' });
    const inserted = makeIssue787Snapshot({
      attemptId: 'attempt-inserted',
      revision: '2',
      snapshotId: 'snapshot-inserted',
    });
    const collision = makeIssue787Snapshot({
      attemptId: 'attempt-collision',
      revision: '2',
      snapshotId: 'snapshot-collision',
      sourceState: 'CONFLICT',
    });
    const beforeBoundary = makeIssue787Snapshot({ nextMaterialBoundary: '2026-09-28T11:00:00.000Z' });
    const atBoundary = makeIssue787Snapshot({
      attemptId: 'attempt-boundary',
      capturedAt: '2026-09-28T11:00:00.400Z',
      evaluatedAt: '2026-09-28T11:00:00.200Z',
      nextMaterialBoundary: '2026-09-28T12:00:00.000Z',
      observedAt: '2026-09-28T11:00:00.300Z',
      operationTime: '2026-09-28T11:00:00.000Z',
      requestedAt: '2026-09-28T11:00:00.100Z',
      revision: '2',
      snapshotId: 'snapshot-boundary',
    });

    expectMaterial(classifyPricingMaterialChange(request(absent, inserted)), ['EXACT_PRICE_KEY_OR_SET_CHANGED']);
    expectMaterial(classifyPricingMaterialChange(request(makeIssue787Snapshot(), collision)), [
      'EXACT_PRICE_KEY_OR_SET_CHANGED',
    ]);
    expectMaterial(classifyPricingMaterialChange(request(beforeBoundary, atBoundary)), [
      'PRICE_SCHEDULE_BOUNDARY_CROSSED',
    ]);
  });

  it('detects purchase identity, quantity, scope, currency, and calculation changes independently of amount equality', () => {
    const previous = makeIssue787Snapshot();
    const currentBase = makeIssue787Snapshot({ attemptId: 'attempt-2', snapshotId: 'snapshot-2' });
    const current = {
      ...currentBase,
      calculationVersions: {
        ...currentBase.calculationVersions,
        arithmeticProfileVersions: ['arithmetic-v2'],
      },
      decision: {
        ...currentBase.decision,
        commercialScope: { ...currentBase.decision.commercialScope, marketId: 'market-sk' },
        currencyCode: 'EUR',
        lines: currentBase.decision.lines.map((line) => ({
          ...line,
          catalog: {
            ...line.catalog,
            quantity: { ...line.catalog.quantity, requested: '2', resulting: '2' },
          },
          occurrenceId: 'line-b',
        })),
        purchasingContext: {
          ...currentBase.decision.purchasingContext,
          contextRef: 'guest-2',
          contextRevision: 'guest-r2',
          currencyResolution: {
            ...currentBase.decision.purchasingContext.currencyResolution,
            currencyCode: 'EUR',
          },
        },
      },
    };

    expectMaterial(classifyPricingMaterialChange(request(previous, current)), [
      'CALCULATION_CONTRACT_CHANGED',
      'COMMERCIAL_SCOPE_CHANGED',
      'CURRENCY_OR_BASIS_CHANGED',
      'PURCHASE_OCCURRENCES_CHANGED',
      'SUBJECT_OR_GUEST_CHANGED',
    ]);
  });

  it('keeps owner inability distinct and preserves generalized non-FX currency contracts', () => {
    const eurPrevious = makeIssue787Snapshot({ currencyCode: 'EUR' });
    const eurCurrent = makeIssue787Snapshot({
      attemptId: 'attempt-eur-2',
      currencyCode: 'EUR',
      snapshotId: 'snapshot-eur-2',
    });
    expectNonMaterial(classifyPricingMaterialChange(request(eurPrevious, eurCurrent)), 'EXACT_MATERIAL_STATE');

    const unavailableBase = makeIssue787Snapshot({
      attemptId: 'attempt-unavailable',
      snapshotId: 'snapshot-unavailable',
    });
    const unavailable = {
      ...unavailableBase,
      materialBindings: unavailableBase.materialBindings.map((binding) => ({
        ...binding,
        sourceEvidence: makeIssue787SourceEvidence({ state: 'UNVERIFIABLE' }),
      })),
    };
    const result = classifyPricingMaterialChange(request(makeIssue787Snapshot(), unavailable));
    expect(Schema.is(PricingMaterialChangeUnverifiableSchema)(result)).toBe(true);
    if (Schema.is(PricingMaterialChangeUnverifiableSchema)(result)) {
      expect(result.reasons).toEqual(['Current owner state is not verifiable for binding binding:price:line-a']);
    }
  });
});
