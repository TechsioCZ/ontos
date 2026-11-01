// The staff market detail (DESIGN 4): current definition, revision history, e-shop associations, lifecycle actions
// and the durable retirement outcome. Pure presentation model over the owner reads.
import type { MarketAffectedUseAssessmentResponse } from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import type { StorefrontApplicationSummary } from '@app/storefront-registry/api/storefront-applications';
import { DateTime, Match, Schema } from 'effect';
import type { MarketHistoryResponse } from '../../shared/apis/market-history.ts';
import type { MarketRetirementOutcome } from '../../shared/domain/market-retirement-intent.ts';
import type { MarketLifecycle } from '../../shared/market-contracts.ts';
import type { CurrentAssociation, CurrentMarket, MarketChannel } from './eshops-model.ts';

export type HistoryDefinition = MarketHistoryResponse['definitions'][number];

/** The definition in force: the catalog's current one, else the newest revision (not yet or no longer in force). */
export const currentDefinition = (
  catalogMarket: CurrentMarket | undefined,
  history: MarketHistoryResponse,
): CurrentMarket | undefined => {
  if (catalogMarket !== undefined) {
    return catalogMarket;
  }
  const [newest] = history.definitions.toSorted((left, right) => right.revision - left.revision);
  return newest;
};

export const RevisionChangeSchema = Schema.Literals([
  'channels',
  'jurisdictions',
  'lifecycle',
  'locales',
  'period',
  'purpose',
]);
export type RevisionChange = typeof RevisionChangeSchema.Type;

export interface RevisionRow {
  readonly changes: readonly RevisionChange[];
  readonly definition: HistoryDefinition;
  readonly revision: number;
}

const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const periodKey = ({ effectivePeriod }: HistoryDefinition) =>
  [effectivePeriod.startsAt, effectivePeriod.endsAt]
    .map((instant) => (instant === undefined ? '' : String(DateTime.toEpochMillis(instant))))
    .join('/');

const changesBetween = (previous: HistoryDefinition, next: HistoryDefinition): readonly RevisionChange[] => {
  const changes: RevisionChange[] = [];
  if (!sameList(previous.channels, next.channels)) {
    changes.push('channels');
  }
  if (
    !sameList(
      previous.jurisdictions.map((jurisdiction) => `${jurisdiction.kind}:${jurisdiction.code}`),
      next.jurisdictions.map((jurisdiction) => `${jurisdiction.kind}:${jurisdiction.code}`),
    )
  ) {
    changes.push('jurisdictions');
  }
  if (previous.lifecycle !== next.lifecycle) {
    changes.push('lifecycle');
  }
  if (!sameList(previous.supportedLocales, next.supportedLocales)) {
    changes.push('locales');
  }
  if (periodKey(previous) !== periodKey(next)) {
    changes.push('period');
  }
  if (previous.purpose !== next.purpose) {
    changes.push('purpose');
  }
  return changes;
};

/** Newest first; each row names what changed against the revision before it. */
export const revisionRows = (history: MarketHistoryResponse): readonly RevisionRow[] => {
  const ordered = history.definitions.toSorted((left, right) => left.revision - right.revision);
  return ordered
    .map((definition, index): RevisionRow => {
      const previous = ordered[index - 1];
      return {
        changes: previous === undefined ? [] : changesBetween(previous, definition),
        definition,
        revision: definition.revision,
      };
    })
    .toReversed();
};

export const marketAssociations = (
  associations: readonly CurrentAssociation[],
  marketId: string,
): readonly CurrentAssociation[] => associations.filter((association) => association.marketRef.resourceId === marketId);

export const LifecycleActionSchema = Schema.Literals(['activate', 'retire', 'suspend']);
export type LifecycleAction = typeof LifecycleActionSchema.Type;

/** Allowed transitions: an active market can be suspended, a suspended one activated; both can be retired. */
export const lifecycleActions = (
  lifecycle: MarketLifecycle,
  retirementPending: boolean,
): readonly LifecycleAction[] => {
  if (retirementPending || lifecycle === 'RETIRED') {
    return [];
  }
  return lifecycle === 'ACTIVE' ? ['suspend', 'retire'] : ['activate', 'retire'];
};

export type RetirementView =
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed'; readonly reason: Extract<MarketRetirementOutcome, { outcome: 'failed' }>['reason'] }
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly stage: Extract<MarketRetirementOutcome, { outcome: 'pending' }>['stage'] };

export const retirementView = (outcome?: MarketRetirementOutcome): RetirementView =>
  outcome === undefined
    ? { kind: 'none' }
    : Match.value(outcome).pipe(
        Match.discriminatorsExhaustive('outcome')({
          completed: (): RetirementView => ({ kind: 'completed' }),
          failed: ({ reason }): RetirementView => ({ kind: 'failed', reason }),
          pending: ({ stage }): RetirementView => ({ kind: 'pending', stage }),
        }),
      );

/** The type-the-code confirmation of a retirement: exact code, ignoring surrounding spaces and letter case. */
export const confirmsMarketCode = (typed: string, marketCode: string): boolean =>
  typed.trim().toUpperCase() === marketCode.toUpperCase();

export interface StorefrontChoice {
  readonly appId: string;
  readonly channels: readonly MarketChannel[];
  readonly tenantId: string;
}

/** E-shops the market can be offered in: not retired, and sharing at least one channel with the market. */
export const storefrontChoices = (
  storefronts: readonly StorefrontApplicationSummary[],
  market: Pick<CurrentMarket, 'channels'>,
): readonly StorefrontChoice[] =>
  storefronts.flatMap((storefront) => {
    const channels = market.channels.filter((channel) => storefront.allowedChannels.includes(channel));
    return storefront.lifecycle === 'RETIRED' || channels.length === 0
      ? []
      : [
          {
            appId: storefront.storefrontAppId,
            channels,
            tenantId: storefront.storefrontApplicationRef.tenantId,
          },
        ];
  });

/** Counts of the retirement impact assessment the Customer Context owner reports for the market. */
export interface RetirementImpact {
  /** Live uses (default market of a sales channel, open proposals) that block the retirement. */
  readonly blocking: number;
  /** Historical records that keep referring to the market after it is retired. */
  readonly retained: number;
}
/** The counts of a verified assessment; any other outcome (stale, rejected, unavailable) cannot be summarized. */
export const retirementImpactOf = (assessment: MarketAffectedUseAssessmentResponse): RetirementImpact | undefined =>
  assessment.outcome === 'VERIFIED'
    ? {
        blocking:
          assessment.liveBlockingReferences.bootstrapDefaults.length +
          assessment.liveBlockingReferences.currentProposals.length,
        retained: assessment.retainedHistoryReferences.length,
      }
    : undefined;
