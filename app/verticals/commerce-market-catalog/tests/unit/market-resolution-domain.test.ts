import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { ResolveCommerceMarketRequestSchema } from '../../shared/apis/resolve-commerce-market.ts';
import type { EligibleMarketTuple, MarketLifecycle } from '../../shared/market-contracts.ts';
import { discoverEligibleMarketTuples, resolveCommerceMarket } from '../../src/domain/market-resolution.ts';
import type { MarketEligibilitySnapshot } from '../../src/domain/market-resolution.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const storefrontRef = { appId: 'shop', tenantId } as const;
const at = '2030-06-01T00:00:00.000Z';
const completenessEvidence = {
  nextApplicabilityBoundary: '2030-07-01T00:00:00.000Z',
  observedAt: at,
  ownerRevision: 'market-eligibility:v1:exact-predicate',
  scope: { kind: 'EXACT_PREDICATE', predicateRef: 'market-eligibility:v1:shop:B2C:all-sellers' },
} as const;

const sellerRef = (resourceId: string) => ({
  moduleId: 'core.identity' as const,
  resourceId,
  resourceType: 'core.identity.legal-entity' as const,
  tenantId,
});
const marketRef = (resourceId: string) => ({
  moduleId: 'commerce.market-catalog' as const,
  resourceId,
  resourceType: 'commerce.market-catalog.market' as const,
  tenantId,
});
const tuple = (
  number: number,
  channel: 'B2B' | 'B2C' = 'B2C',
  sellerId = `00000000-0000-4000-8000-00000000000${number}`,
): EligibleMarketTuple => ({
  associationRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: `10000000-0000-4000-8000-00000000000${number}`,
    resourceType: 'commerce.market-catalog.storefront-association',
    tenantId,
  },
  associationRevision: number,
  channel,
  marketDefinitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: `20000000-0000-4000-8000-00000000000${number}`,
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  marketRef: marketRef(`30000000-0000-4000-8000-00000000000${number}`),
  sellingLegalEntityRef: sellerRef(sellerId),
});

const snapshot = (
  facts: readonly Readonly<{ readonly lifecycle: MarketLifecycle; readonly tuple: EligibleMarketTuple }>[],
): MarketEligibilitySnapshot => ({
  completenessEvidence: Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)(completenessEvidence),
  effectiveAt: Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema.fields.effectiveAt)(at),
  evaluatedAt: Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema.fields.effectiveAt)(
    '2030-06-01T00:00:01.000Z',
  ),
  facts,
  nextApplicabilityBoundary: Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema.fields.effectiveAt)(
    completenessEvidence.nextApplicabilityBoundary,
  ),
});

const request = (overrides: Partial<typeof ResolveCommerceMarketRequestSchema.Encoded> = {}) =>
  Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
    channel: 'B2C',
    effectiveAt: at,
    storefrontRef,
    ...overrides,
  });

describe('Commerce Market eligible tuple discovery and selection', () => {
  it('returns complete empty discovery without manufacturing an authoritative winner', () => {
    const result = discoverEligibleMarketTuples(request(), snapshot([]));
    expect(result.tuples).toEqual([]);
    expect(result.completenessEvidence.ownerRevision).toBe(completenessEvidence.ownerRevision);
    expect(result.effectiveAt).not.toEqual(result.evaluatedAt);
  });

  it('resolves exactly one complete eligible tuple', () => {
    const result = resolveCommerceMarket({
      request: request(),
      snapshot: snapshot([{ lifecycle: 'ACTIVE', tuple: tuple(1) }]),
    });
    expect(result).toMatchObject({ outcome: 'MARKET_RESOLVED', selectionSource: 'SOLE_ELIGIBLE' });
  });

  it('requires selection for complete multi-Market and multiple-seller sets without a tie-break', () => {
    const result = resolveCommerceMarket({
      request: request(),
      snapshot: snapshot([
        { lifecycle: 'ACTIVE', tuple: tuple(1) },
        { lifecycle: 'ACTIVE', tuple: tuple(2) },
      ]),
    });
    expect(result).toMatchObject({ outcome: 'MARKET_SELECTION_REQUIRED' });
    expect(result.outcome === 'MARKET_SELECTION_REQUIRED' ? result.choices : []).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('AMBIGUOUS_MARKET');
  });

  it('requires selection for multiple Storefront associations without using geography or order', () => {
    const reversed = [tuple(2), tuple(1)].map((value) => ({ lifecycle: 'ACTIVE' as const, tuple: value }));
    const result = resolveCommerceMarket({ request: request(), snapshot: snapshot(reversed) });
    expect(result).toMatchObject({ outcome: 'MARKET_SELECTION_REQUIRED' });
    expect(result.outcome === 'MARKET_SELECTION_REQUIRED' ? result.choices : []).toEqual([tuple(2), tuple(1)]);
  });

  it('supports Guest discovery without a preselected seller', () => {
    const result = discoverEligibleMarketTuples(
      request({ subject: { kind: 'GUEST', subjectRef: 'guest-session:safe' } }),
      snapshot([
        { lifecycle: 'ACTIVE', tuple: tuple(1) },
        { lifecycle: 'ACTIVE', tuple: tuple(2) },
      ]),
    );
    expect(result.tuples).toHaveLength(2);
  });

  it('applies an exact B2B seller restriction', () => {
    const restrictedSeller = tuple(2, 'B2B').sellingLegalEntityRef;
    const result = discoverEligibleMarketTuples(
      request({ channel: 'B2B', sellingLegalEntityRestriction: restrictedSeller }),
      snapshot([
        { lifecycle: 'ACTIVE', tuple: tuple(1, 'B2B') },
        { lifecycle: 'ACTIVE', tuple: tuple(2, 'B2B') },
      ]),
    );
    expect(result.tuples).toEqual([tuple(2, 'B2B')]);
  });

  it('accepts a valid explicit selection and never substitutes another tuple', () => {
    const selected = tuple(2);
    const result = resolveCommerceMarket({
      request: request({
        explicitSelection: { marketRef: selected.marketRef, sellingLegalEntityRef: selected.sellingLegalEntityRef },
      }),
      snapshot: snapshot([
        { lifecycle: 'ACTIVE', tuple: tuple(1) },
        { lifecycle: 'ACTIVE', tuple: selected },
      ]),
    });
    expect(result).toMatchObject({ outcome: 'MARKET_RESOLVED', selectedTuple: selected, selectionSource: 'EXPLICIT' });
  });

  it('rejects an explicit Market that is not associated with the Storefront', () => {
    const selected = tuple(2);
    const result = resolveCommerceMarket({
      request: request({
        explicitSelection: { marketRef: selected.marketRef, sellingLegalEntityRef: selected.sellingLegalEntityRef },
      }),
      snapshot: snapshot([{ lifecycle: 'ACTIVE', tuple: tuple(1) }]),
    });
    expect(result).toMatchObject({ outcome: 'MARKET_NOT_ALLOWED_FOR_STOREFRONT' });
  });

  it('rejects a selected Market outside the requested Channel', () => {
    const selected = tuple(1, 'B2B');
    const result = resolveCommerceMarket({
      request: request({
        explicitSelection: { marketRef: selected.marketRef, sellingLegalEntityRef: selected.sellingLegalEntityRef },
      }),
      snapshot: snapshot([{ lifecycle: 'ACTIVE', tuple: selected }]),
    });
    expect(result).toMatchObject({ outcome: 'MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL' });
  });

  it.each(['SUSPENDED', 'RETIRED'] as const)('rejects an explicit %s Market as not Active', (lifecycle) => {
    const selected = tuple(1);
    const result = resolveCommerceMarket({
      request: request({
        explicitSelection: { marketRef: selected.marketRef, sellingLegalEntityRef: selected.sellingLegalEntityRef },
      }),
      snapshot: snapshot([{ lifecycle, tuple: selected }]),
    });
    expect(result).toMatchObject({ outcome: 'MARKET_NOT_ACTIVE' });
  });

  it('retains bootstrap policy evidence only for a valid configured default', () => {
    const selected = tuple(1);
    const result = resolveCommerceMarket({
      request: request({
        bootstrapDefault: {
          marketRef: selected.marketRef,
          policyRevision: 'bootstrap-policy:7',
          sellingLegalEntityRef: selected.sellingLegalEntityRef,
        },
      }),
      snapshot: snapshot([{ lifecycle: 'ACTIVE', tuple: selected }]),
    });
    expect(result).toMatchObject({
      bootstrapPolicyRevision: 'bootstrap-policy:7',
      outcome: 'MARKET_RESOLVED',
      selectionSource: 'BOOTSTRAP_DEFAULT',
    });
  });

  it('applies one Channel and seller bootstrap default across eligible Storefront contexts', () => {
    const selected = tuple(1);
    const bootstrapDefault = {
      marketRef: selected.marketRef,
      policyRevision: 'bootstrap-policy:8',
      sellingLegalEntityRef: selected.sellingLegalEntityRef,
    } as const;
    const eligibility = snapshot([{ lifecycle: 'ACTIVE', tuple: selected }]);
    const first = resolveCommerceMarket({
      request: request({ bootstrapDefault }),
      snapshot: eligibility,
    });
    const second = resolveCommerceMarket({
      request: request({ bootstrapDefault, storefrontRef: { appId: 'second-shop', tenantId } }),
      snapshot: eligibility,
    });

    expect(first).toMatchObject({
      bootstrapPolicyRevision: 'bootstrap-policy:8',
      outcome: 'MARKET_RESOLVED',
      selectedTuple: selected,
    });
    expect(second).toEqual(first);
  });

  it('fails closed for duplicate Current material tuples', () => {
    const duplicate = { ...tuple(1), associationRevision: 2 };
    const result = resolveCommerceMarket({
      request: request(),
      snapshot: snapshot([
        { lifecycle: 'ACTIVE', tuple: tuple(1) },
        { lifecycle: 'ACTIVE', tuple: duplicate },
      ]),
    });
    expect(result).toMatchObject({ outcome: 'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT' });
  });
});
