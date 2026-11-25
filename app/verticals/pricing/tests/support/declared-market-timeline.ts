import {
  PricingCurrentMarketEvidenceRequestSchema,
  PricingCurrentMarketEvidenceResponseSchema,
  PricingMarketSourceReceiptSchema,
} from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import type { PricingCurrentMarketEvidenceRequest } from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import { DateTime, Effect, Schema } from 'effect';

/**
 * DECLARED Commerce Market owner with a parameterizable revision timeline (#1250, ONT-AUD-0028).
 *
 * This is a stand-in, not the Market owner: it answers the published `pricing-current-market-evidence` contract from a
 * timeline the scenario declares (immutable definition revisions of ONE Market identity, each with its own effective
 * period and channels, plus lifecycle periods) and the owner's completeness generation. It mirrors the selection rule
 * and the classification of the real owner so a public Pricing Read can be driven through R1 -> R2 -> R2 ended:
 *  - `read_pricing_current_market_evidence` (migration 20261019161755_market-pricing-effective-revision): among the
 *    revisions of the exact Market and seller that STARTED at or before the requested instant, the highest revision
 *    number is the only candidate; if that candidate has ended, the Market has no Current definition (MISSING), so an
 *    open predecessor is never restored; more than one lifecycle period is a CONFLICT; a requested instant later than
 *    the owner observation is UNVERIFIABLE; another seller or Market, or a channel the revision does not offer, is ABSENT.
 *  - `classifySnapshot` / `sameRetainedSource` (pricing-current-market-evidence.service.ts): a replay of a retained
 *    receipt that differs in generation or in the exact Current fact is `PRICING_MARKET_SOURCE_CHANGED`.
 * The REAL owner's selection is proven by the Market owner's own native tests and by the November-named Pricing test
 * (`market-revision-whole-current-pricing-postgres.test.ts`); it is NOT exercised by the registered Read through this
 * stand-in. Nothing here decides anything the Pricing consumer should decide: it only answers.
 */
const DeclaredMarketChannelSchema = Schema.Literals(['B2B', 'B2C']);
export type DeclaredMarketChannel = typeof DeclaredMarketChannelSchema.Type;
const DeclaredMarketLifecycleSchema = Schema.Literals(['ACTIVE', 'RETIRED', 'SUSPENDED']);

export interface DeclaredMarketRevision {
  readonly channels: readonly DeclaredMarketChannel[];
  readonly effectiveFrom: DateTime.Utc;
  /** Exclusive end; `null` keeps the revision open. */
  readonly effectiveTo: DateTime.Utc | null;
  readonly revision: number;
}

export interface DeclaredMarketLifecyclePeriod {
  readonly effectiveFrom: DateTime.Utc;
  readonly effectiveTo: DateTime.Utc | null;
  readonly lifecycle: typeof DeclaredMarketLifecycleSchema.Type;
}

/** What the declared owner answered one request with, so a scenario asserts the owner's side of an outcome. */
export interface DeclaredMarketAnswerObservation {
  readonly effectiveAt: DateTime.Utc;
  readonly generation: number;
  readonly outcome: string;
  /** True when the request replayed a retained receipt (an owner final-fence call). */
  readonly replay: boolean;
  /** The definition revision number the owner selected, when it answered PRESENT. */
  readonly revision: number | null;
}

const MARKET_MODULE = 'commerce.market-catalog';
const FOREIGN_MARKET_ID = 'TEST:1250:foreign-market';
const millis = DateTime.toEpochMillis;
const iso = DateTime.formatIso;
const instant = (epochMillis: number) => DateTime.makeUnsafe(epochMillis);
const covers = (
  period: { readonly effectiveFrom: DateTime.Utc; readonly effectiveTo: DateTime.Utc | null },
  at: number,
) => millis(period.effectiveFrom) <= at && (period.effectiveTo === null || millis(period.effectiveTo) > at);

/** The fact revision reference the declared owner issues for a definition revision under a lifecycle period. */
export const declaredMarketFactRevisionRef = (revision: number, lifecycleIndex = 0) =>
  `TEST:1250:definition:r${revision}:lifecycle:${lifecycleIndex}`;

/** Optional wire keys are added only when present; the typed base stays the contract's own shape. */
const withOptional = <Base extends object, Extra extends object>(base: Base, extra: Extra | undefined): Base =>
  extra === undefined ? base : Object.assign(base, extra);

type EncodedReceipt = typeof PricingMarketSourceReceiptSchema.Encoded;
interface DeclaredTimeline {
  readonly lifecycles: readonly DeclaredMarketLifecyclePeriod[];
  readonly revisions: readonly DeclaredMarketRevision[];
  readonly sellingLegalEntityId: string;
}
interface PresentSnapshot {
  readonly definition: DeclaredMarketRevision;
  readonly lifecycle: DeclaredMarketLifecyclePeriod;
  readonly lifecycleIndex: number;
  readonly state: 'PRESENT';
}
type Snapshot = PresentSnapshot | { readonly state: 'ABSENT' | 'CONFLICT' | 'MISSING' };

/** The owner's selection rule: rank the revisions that started first, then test the winner's end. */
const classify = (
  timeline: DeclaredTimeline,
  scope: { readonly channel: DeclaredMarketChannel; readonly sameIdentity: boolean },
  at: number,
): Snapshot => {
  if (!scope.sameIdentity) {
    return { state: 'ABSENT' };
  }
  const [candidate] = timeline.revisions
    .filter(({ effectiveFrom }) => millis(effectiveFrom) <= at)
    .toSorted((left, right) => right.revision - left.revision);
  const definition = candidate !== undefined && covers(candidate, at) ? candidate : undefined;
  const lifecycles = timeline.lifecycles.filter((period) => covers(period, at));
  const [lifecycle] = lifecycles;
  if (lifecycles.length > 1) {
    return { state: 'CONFLICT' };
  }
  if (definition === undefined || lifecycle === undefined) {
    return { state: 'MISSING' };
  }
  if (lifecycle.lifecycle !== 'ACTIVE' || !definition.channels.includes(scope.channel)) {
    return { state: 'ABSENT' };
  }
  return { definition, lifecycle, lifecycleIndex: timeline.lifecycles.indexOf(lifecycle), state: 'PRESENT' };
};

const nextBoundaryOf = (timeline: DeclaredTimeline, horizon: number): number | undefined => {
  const [next] = [...timeline.revisions, ...timeline.lifecycles]
    .flatMap(({ effectiveFrom, effectiveTo }) =>
      effectiveTo === null ? [effectiveFrom] : [effectiveFrom, effectiveTo],
    )
    .map(millis)
    .filter((boundary) => boundary > horizon)
    .toSorted((left, right) => left - right);
  return next;
};

const sameFacts = (retained: EncodedReceipt['currentFacts'], current: EncodedReceipt['currentFacts']) =>
  retained.length === current.length &&
  retained.every((fact, index) => {
    const other = current[index];
    return (
      other !== undefined &&
      fact.factRef === other.factRef &&
      fact.factRevisionRef === other.factRevisionRef &&
      fact.verificationRef === other.verificationRef &&
      fact.effectivePeriod.startsAt === other.effectivePeriod.startsAt &&
      fact.effectivePeriod.endsAt === other.effectivePeriod.endsAt
    );
  });

/** Observation time is excluded, exactly as the owner excludes it; generation and the exact Current fact are not. */
const sameRetainedSource = (retained: EncodedReceipt, current: EncodedReceipt) =>
  retained.state === current.state &&
  retained.authority.generation === current.authority.generation &&
  retained.authority.ownerRootRef === current.authority.ownerRootRef &&
  retained.authority.ownerSetRevisionRef === current.authority.ownerSetRevisionRef &&
  retained.authority.predicateRef === current.authority.predicateRef &&
  retained.authority.verificationRef === current.authority.verificationRef &&
  retained.authority.nextApplicabilityBoundary === current.authority.nextApplicabilityBoundary &&
  sameFacts(retained.currentFacts, current.currentFacts);

/** The one Current fact of a PRESENT snapshot: the market under its definition revision and lifecycle period. */
const factOf = (snapshot: PresentSnapshot, marketId: string, predicateRef: string, setVerificationRef: string) => {
  const { definition, lifecycle, lifecycleIndex } = snapshot;
  const factRevisionRef = declaredMarketFactRevisionRef(definition.revision, lifecycleIndex);
  const [end] = [definition.effectiveTo, lifecycle.effectiveTo]
    .filter((candidate): candidate is DateTime.Utc => candidate !== null)
    .map(millis)
    .toSorted((left, right) => left - right);
  const effectivePeriod = withOptional(
    { startsAt: iso(instant(Math.max(millis(definition.effectiveFrom), millis(lifecycle.effectiveFrom)))) },
    end === undefined ? undefined : { endsAt: iso(instant(end)) },
  );
  return {
    effectivePeriod,
    factRef: marketId,
    factRevisionRef,
    verificationRef: `TEST:1250:market-fact-proof:${[predicateRef, marketId, factRevisionRef, setVerificationRef].join('|')}`,
  };
};

interface ReceiptScope {
  readonly channel: DeclaredMarketChannel;
  readonly effectiveAt: DateTime.Utc;
  readonly generation: number;
  readonly marketId: string;
  readonly nextBoundary: number | undefined;
  readonly observedAt: DateTime.Utc;
  readonly sellerId: string;
  readonly tenantId: string;
}

/** The receipt the real owner issues for a snapshot: a stable set identity per (scope, generation, boundary). */
const receiptOf = (snapshot: Snapshot, scope: ReceiptScope): EncodedReceipt => {
  const predicateRef = [
    'TEST:1250:market-predicate',
    scope.tenantId,
    scope.sellerId,
    scope.channel,
    scope.marketId,
    iso(scope.effectiveAt),
  ].join(':');
  const ownerRootRef = `TEST:1250:market-root:${scope.tenantId}`;
  const ownerSetRevisionRef = `TEST:1250:market-set:generation:${scope.generation}`;
  const verificationRef = `TEST:1250:market-set-proof:${[
    ownerRootRef,
    predicateRef,
    ownerSetRevisionRef,
    scope.nextBoundary === undefined ? 'unbounded' : iso(instant(scope.nextBoundary)),
  ].join('|')}`;
  const authority = withOptional(
    {
      generation: scope.generation,
      observedAt: iso(scope.observedAt),
      ownerRootRef,
      ownerSetRevisionRef,
      predicateRef,
      verificationRef,
    },
    scope.nextBoundary === undefined ? undefined : { nextApplicabilityBoundary: iso(instant(scope.nextBoundary)) },
  );
  return snapshot.state === 'PRESENT'
    ? {
        authority,
        currentFacts: [factOf(snapshot, scope.marketId, predicateRef, verificationRef)],
        state: 'PRESENT',
      }
    : { authority, currentFacts: [], state: 'ABSENT' };
};

/** The Market definition a PRESENT answer carries, for the revision the owner selected. */
const marketDefinitionOf = (
  snapshot: PresentSnapshot,
  marketRef: PricingCurrentMarketEvidenceRequest['commercialScope']['marketRef'],
  sellingLegalEntityRef: PricingCurrentMarketEvidenceRequest['commercialScope']['sellingLegalEntityRef'],
) => {
  const { definition, lifecycle } = snapshot;
  const definitionRef = (revision: number) => ({
    moduleId: MARKET_MODULE,
    resourceId: `TEST:1250:market-definition:r${revision}`,
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId: marketRef.tenantId,
  });
  return withOptional(
    {
      channels: definition.channels,
      definitionRevisionRef: definitionRef(definition.revision),
      effectivePeriod: withOptional(
        { startsAt: iso(definition.effectiveFrom) },
        definition.effectiveTo === null ? undefined : { endsAt: iso(definition.effectiveTo) },
      ),
      jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
      lifecycle: lifecycle.lifecycle,
      marketCode: 'CZ',
      marketRef,
      purpose: `Declared TEST Market definition revision ${definition.revision}`,
      revision: definition.revision,
      sellingLegalEntityRef,
      supportedLocales: ['cs-CZ'],
    },
    definition.revision > 1 ? { previousDefinitionRevisionRef: definitionRef(definition.revision - 1) } : undefined,
  );
};

/** The declared Market owner; one instance per harness, mutated only by the scenario that declares a timeline. */
export const declaredMarketOwnerFor = (identity: { readonly marketId: string }) => {
  let timeline: DeclaredTimeline | null = null;
  let generation = 0;
  let refusals = 0;
  let foreignMarket = false;
  const answers: DeclaredMarketAnswerObservation[] = [];

  const answer = Effect.fn('DeclaredMarket.answer')(function* answer(request: PricingCurrentMarketEvidenceRequest) {
    const observedAtMillis = millis(yield* DateTime.now);
    const observedAt = iso(instant(observedAtMillis));
    const effectiveAt = millis(request.effectiveAt);
    const encodedRequest = yield* Schema.encodeEffect(PricingCurrentMarketEvidenceRequestSchema)(request);
    const { channel, marketRef, sellingLegalEntityRef } = request.commercialScope;
    const record = (outcome: string, revision: number | null) => {
      answers.push({
        effectiveAt: request.effectiveAt,
        generation,
        outcome,
        replay: request.retainedReceipt !== undefined,
        revision,
      });
    };
    const respond = Effect.fn('DeclaredMarket.respond')(function* respond(body: Schema.Json) {
      const decoded = yield* Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceResponseSchema)(body);
      const encoded = yield* Schema.encodeEffect(PricingCurrentMarketEvidenceResponseSchema)(decoded);
      record(encoded.outcome, encoded.outcome === 'PRICING_MARKET_SOURCE_PRESENT' ? encoded.market.revision : null);
      return encoded;
    });
    const failure = (outcome: string, reason: string, retryable: boolean) =>
      respond(
        withOptional(
          { observedAt, outcome, reason, request: encodedRequest },
          retryable ? { retryable: true } : undefined,
        ),
      );

    if (refusals > 0) {
      refusals -= 1;
      return yield* respond({
        outcome: 'PRICING_MARKET_SOURCE_UNAVAILABLE',
        reason: 'Declared Market owner refusal (test-injected)',
        request: encodedRequest,
        retryable: true,
      });
    }
    if (timeline === null) {
      return yield* Effect.die('The declared Market owner has no timeline');
    }
    const declared = timeline;
    if (effectiveAt > observedAtMillis) {
      return yield* failure(
        'PRICING_MARKET_SOURCE_UNVERIFIABLE',
        'The requested Pricing operation time is later than the owner observation',
        true,
      );
    }
    const snapshot = classify(
      declared,
      {
        channel,
        sameIdentity:
          marketRef.resourceId === identity.marketId &&
          sellingLegalEntityRef.resourceId === declared.sellingLegalEntityId,
      },
      effectiveAt,
    );
    if (snapshot.state === 'CONFLICT') {
      return yield* failure(
        'PRICING_MARKET_SOURCE_CONFLICT',
        'Multiple Current Market lifecycle facts match the exact scope',
        false,
      );
    }
    if (snapshot.state === 'MISSING') {
      return yield* failure(
        'PRICING_MARKET_SOURCE_MISSING',
        'Current Market definition or lifecycle evidence is incomplete',
        false,
      );
    }
    if (request.verifyThrough !== undefined && observedAtMillis < millis(request.verifyThrough)) {
      return yield* failure(
        'PRICING_MARKET_SOURCE_UNVERIFIABLE',
        'Commerce Market owner observation does not span the requested aggregate fence',
        true,
      );
    }
    const receipt = receiptOf(snapshot, {
      channel,
      effectiveAt: request.effectiveAt,
      generation,
      marketId: marketRef.resourceId,
      nextBoundary: nextBoundaryOf(declared, Math.max(effectiveAt, observedAtMillis)),
      observedAt: instant(observedAtMillis),
      sellerId: sellingLegalEntityRef.resourceId,
      tenantId: marketRef.tenantId,
    });
    if (request.retainedReceipt !== undefined) {
      const retained = yield* Schema.encodeEffect(PricingMarketSourceReceiptSchema)(request.retainedReceipt);
      if (!sameRetainedSource(retained, receipt)) {
        return yield* respond({
          currentReceipt: receipt,
          observedAt,
          outcome: 'PRICING_MARKET_SOURCE_CHANGED',
          reason: 'Commerce Market owner generation or exact Current fact changed after evaluation',
          request: encodedRequest,
          retryable: true,
        });
      }
    }
    const verified = withOptional(
      { receipt, request: encodedRequest },
      encodedRequest.verifyThrough === undefined ? undefined : { verifiedThrough: encodedRequest.verifyThrough },
    );
    if (snapshot.state !== 'PRESENT') {
      return yield* respond({ ...verified, outcome: 'PRICING_MARKET_SOURCE_ABSENT' });
    }
    const market = marketDefinitionOf(snapshot, marketRef, sellingLegalEntityRef);
    const body = { ...verified, market, outcome: 'PRICING_MARKET_SOURCE_PRESENT' };
    if (foreignMarket) {
      // A PRESENT answer that binds ANOTHER Market identity: the published contract itself refuses it, so the wire body
      // is built without schema validation. The Pricing consumer must fail closed on it.
      record('PRICING_MARKET_SOURCE_PRESENT', snapshot.definition.revision);
      return { ...body, market: { ...market, marketRef: { ...marketRef, resourceId: FOREIGN_MARKET_ID } } };
    }
    return yield* respond(body);
  });

  return {
    answer,
    /** Answers every PRESENT read for ANOTHER Market identity (a body the published contract refuses) while `on`. */
    answerForeignMarket: (on: boolean) =>
      Effect.sync(() => {
        foreignMarket = on;
      }),
    answers,
    /**
     * Declares the owner's timeline and advances its completeness generation once, as every Market owner write does.
     * Without `lifecycles`, one ACTIVE period starts with the earliest revision and stays open.
     */
    declare: (input: {
      readonly lifecycles?: readonly DeclaredMarketLifecyclePeriod[];
      readonly revisions: readonly DeclaredMarketRevision[];
      readonly sellingLegalEntityId: string;
    }) =>
      Effect.sync(() => {
        const [first] = input.revisions.map(({ effectiveFrom }) => millis(effectiveFrom)).toSorted((a, b) => a - b);
        timeline = {
          lifecycles: input.lifecycles ?? [
            { effectiveFrom: instant(first ?? 0), effectiveTo: null, lifecycle: 'ACTIVE' },
          ],
          revisions: input.revisions,
          sellingLegalEntityId: input.sellingLegalEntityId,
        };
        generation += 1;
      }),
    generation: () => generation,
    /** Whether a scenario declared a timeline; otherwise the harness keeps its fixed revision-1 stand-in. */
    isDeclared: () => timeline !== null,
    /** The next `count` reads are refused with the owner's retryable UNAVAILABLE (pass 0 to clear). */
    refuse: (count: number) =>
      Effect.sync(() => {
        refusals = count;
      }),
    /** A write that changes no Current fact still advances the owner's completeness generation. */
    republish: () =>
      Effect.sync(() => {
        generation += 1;
      }),
  } as const;
};
