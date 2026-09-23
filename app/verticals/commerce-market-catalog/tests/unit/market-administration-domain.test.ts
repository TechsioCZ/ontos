import { describe, expect, it } from 'effect-rstest';
import { Predicate } from 'effect';
import {
  decideAssociationRemoval,
  decideAssociationWrite,
  decideDefinitionRevision,
  decideLifecycleTransition,
  decideMarketCreate,
  halfOpenPeriodsOverlap,
} from '../../src/domain/market-administration.ts';
import type {
  AssociationDecision,
  LifecycleDecision,
  MarketCreateDecision,
  RevisionDecision,
} from '../../src/domain/market-administration.ts';

const market = {
  aggregateRevision: 4,
  businessCode: 'CZ_MAIN',
  currentDefinitionRevision: 2,
  lifecycle: 'ACTIVE' as const,
  marketId: 'market-1',
  sellingLegalEntityId: 'seller-1',
};
const association = {
  associationId: 'association-1',
  channel: 'B2C' as const,
  effectivePeriod: { endsAt: '2027-01-01T00:00:00.000Z', startsAt: '2026-01-01T00:00:00.000Z' },
  marketId: 'market-1',
  revision: 2,
  sellingLegalEntityId: 'seller-1',
  storefrontAppId: 'shop-b2c',
};

type DomainDecision = AssociationDecision | LifecycleDecision | MarketCreateDecision | RevisionDecision;
const expectTagged = (value: DomainDecision, tag: string) => expect(Predicate.isTagged(value, tag)).toBe(true);

describe('Market administration transitions', () => {
  it('uses inclusive-start/exclusive-end overlap semantics', () => {
    expect(
      halfOpenPeriodsOverlap(
        { endsAt: '2026-02-01T00:00:00.000Z', startsAt: '2026-01-01T00:00:00.000Z' },
        { startsAt: '2026-02-01T00:00:00.000Z' },
      ),
    ).toBe(false);
    expect(
      halfOpenPeriodsOverlap(
        { endsAt: '2026-02-02T00:00:00.000Z', startsAt: '2026-01-01T00:00:00.000Z' },
        { startsAt: '2026-02-01T00:00:00.000Z' },
      ),
    ).toBe(true);
  });

  it('preserves Tenant-wide code uniqueness and immutable seller identity', () => {
    expectTagged(
      decideMarketCreate(market, undefined, {
        businessCode: 'CZ_MAIN',
        marketId: 'market-1',
        sellingLegalEntityId: 'seller-1',
      }),
      'reused',
    );
    expectTagged(
      decideMarketCreate(market, undefined, {
        businessCode: 'CZ_MAIN',
        marketId: 'market-1',
        sellingLegalEntityId: 'seller-2',
      }),
      'seller_identity_immutable',
    );
    expectTagged(
      decideMarketCreate(undefined, market, {
        businessCode: 'CZ_MAIN',
        marketId: 'market-2',
        sellingLegalEntityId: 'seller-2',
      }),
      'market_code_conflict',
    );
  });

  it('requires expected-current definition evidence and advances immutable revisions', () => {
    const conflict = decideDefinitionRevision(market, 1);
    expectTagged(conflict, 'revision_conflict');
    expect(conflict).toMatchObject({ actualRevision: 2 });
    const revised = decideDefinitionRevision(market, 2);
    expectTagged(revised, 'revised');
    expect(revised).toMatchObject({ nextAggregateRevision: 5, nextDefinitionRevision: 3 });
  });

  it('supports suspend/reactivate/retire while retirement remains terminal', () => {
    const suspended = decideLifecycleTransition(market, 4, 'SUSPENDED');
    expectTagged(suspended, 'transitioned');
    expect(suspended).toMatchObject({ changed: true });
    const reactivated = decideLifecycleTransition({ ...market, lifecycle: 'SUSPENDED' }, 4, 'ACTIVE');
    expectTagged(reactivated, 'transitioned');
    expect(reactivated).toMatchObject({ changed: true });
    expectTagged(
      decideLifecycleTransition({ ...market, lifecycle: 'RETIRED' }, 4, 'ACTIVE'),
      'invalid_lifecycle_transition',
    );
    const stale = decideLifecycleTransition(market, 3, 'RETIRED');
    expectTagged(stale, 'revision_conflict');
    expect(stale).toMatchObject({ actualRevision: 4 });
  });

  it('rejects overlap/stale revision and treats exact association replay as idempotent', () => {
    const { revision: _revision, ...proposed } = association;
    expectTagged(decideAssociationWrite(association, [association], proposed, 2), 'already_applied');
    expectTagged(
      decideAssociationWrite(association, [association], { ...proposed, associationId: 'association-2' }, 1),
      'revision_conflict',
    );
    expectTagged(
      decideAssociationWrite(undefined, [association], { ...proposed, associationId: 'association-2' }),
      'overlapping_association',
    );
    const stale = decideAssociationRemoval(association, 1, '2026-06-01T00:00:00.000Z');
    expectTagged(stale, 'revision_conflict');
    expect(stale).toMatchObject({ actualRevision: 2 });
    const removal = decideAssociationRemoval(association, 2, '2026-06-01T00:00:00.000Z');
    expectTagged(removal, 'write');
    expect(removal).toMatchObject({ nextRevision: 3 });
  });
});
