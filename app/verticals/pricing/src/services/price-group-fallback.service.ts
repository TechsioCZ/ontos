import type {
  PriceGroupFallbackExactLookupRequest,
  PriceGroupFallbackExactLookupResult,
  PriceGroupFallbackResolution,
  PriceGroupFallbackResolutionInput,
} from '@app/pricing-contracts/domain/price-group-fallback';
import {
  PriceGroupFallbackExactLookupRequestSchema,
  PriceGroupFallbackExactLookupResultSchema,
} from '@app/pricing-contracts/domain/price-group-fallback';
import type { PriceGroupInterpretationBasis } from '@app/pricing-contracts/domain/price-group-interpretation';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import { Context, Effect, Match, Option, Schema } from 'effect';

export interface PriceGroupFallbackExactLookupPort {
  readonly lookup: (
    request: PriceGroupFallbackExactLookupRequest,
  ) => Effect.Effect<PriceGroupFallbackExactLookupResult>;
}

class PriceGroupFallbackExactLookup extends Context.Service<
  PriceGroupFallbackExactLookup,
  PriceGroupFallbackExactLookupPort
>()('@app/pricing/services/price-group-fallback.service/PriceGroupFallbackExactLookup') {}

interface PriceGroupFallbackResolverService {
  readonly resolve: (input: PriceGroupFallbackResolutionInput) => Effect.Effect<PriceGroupFallbackResolution>;
}

class PriceGroupFallbackResolver extends Context.Service<
  PriceGroupFallbackResolver,
  PriceGroupFallbackResolverService
>()('@app/pricing/services/price-group-fallback.service/PriceGroupFallbackResolver') {}

const exactLookupRequestEquivalence = Schema.toEquivalence(PriceGroupFallbackExactLookupRequestSchema);

const makeExactKey = (
  basis: PriceGroupInterpretationBasis,
  priceGroupSelector: PriceIdentityKey['priceGroupSelector'],
): PriceIdentityKey => ({
  catalogSelection: basis.catalogSelection,
  commercialScope: basis.commercialScope,
  currencyCode: basis.currencyCode,
  priceGroupSelector,
  unitBasis: basis.unitBasis,
});

const noGroupRequest = (
  basis: PriceGroupInterpretationBasis,
  effectiveAt: string,
): PriceGroupFallbackExactLookupRequest => ({
  effectiveAt,
  exactKey: makeExactKey(basis, { kind: 'NO_GROUP' }),
});

const assignedGroupRequest = (
  input: Extract<PriceGroupFallbackResolutionInput, { readonly _tag: 'ASSIGNED' }>,
): PriceGroupFallbackExactLookupRequest => ({
  effectiveAt: input.effectiveAt,
  exactKey: makeExactKey(input.interpretation.basis, {
    kind: 'PRICE_GROUP',
    priceGroupRef: input.interpretation.priceGroupRef,
  }),
});

const indeterminate = (
  resolutionInput: PriceGroupFallbackResolutionInput,
  reason: 'OWNER_STATE_UNAVAILABLE' | 'OWNER_STATE_UNVERIFIABLE',
  lookup?: Extract<PriceGroupFallbackExactLookupResult, { readonly _tag: 'UNAVAILABLE' | 'UNVERIFIABLE' }>,
): PriceGroupFallbackResolution =>
  lookup === undefined
    ? { _tag: 'INDETERMINATE', reason, resolutionInput }
    : { _tag: 'INDETERMINATE', lookup, reason, resolutionInput };

const mapTerminalLookup = (
  resolutionInput: PriceGroupFallbackResolutionInput,
  lookup: Exclude<PriceGroupFallbackExactLookupResult, { readonly _tag: 'ABSENT' | 'FOUND' }>,
): PriceGroupFallbackResolution =>
  Match.value(lookup).pipe(
    Match.tag('CONFLICT', (conflict) => ({
      _tag: 'CONFLICT' as const,
      lookup: conflict,
      reason: 'COMPETING_CURRENT_EXACT_PRICES' as const,
      resolutionInput,
    })),
    Match.tag('INVALID', (invalid) => ({
      _tag: 'CONFIGURATION_ERROR' as const,
      lookup: invalid,
      reason: invalid.reason,
      resolutionInput,
    })),
    Match.tag('UNAVAILABLE', (unavailable) => indeterminate(resolutionInput, 'OWNER_STATE_UNAVAILABLE', unavailable)),
    Match.tag('UNVERIFIABLE', (unverifiable) =>
      indeterminate(resolutionInput, 'OWNER_STATE_UNVERIFIABLE', unverifiable),
    ),
    Match.exhaustive,
  );

const decodeLookup = (
  expected: PriceGroupFallbackExactLookupRequest,
  result: PriceGroupFallbackExactLookupResult,
): Option.Option<PriceGroupFallbackExactLookupResult> => {
  const decoded = Schema.decodeOption(PriceGroupFallbackExactLookupResultSchema, {
    onExcessProperty: 'error',
  })(result);
  return Option.isSome(decoded) && exactLookupRequestEquivalence(decoded.value.request, expected)
    ? decoded
    : Option.none();
};

const lookupExact = Effect.fn('PriceGroupFallback.lookupExact')(function* lookupExact(
  request: PriceGroupFallbackExactLookupRequest,
  port: PriceGroupFallbackExactLookupPort,
) {
  const result = yield* port.lookup(request);
  return decodeLookup(request, result);
});

const resolveNoGroup = Effect.fn('PriceGroupFallback.resolveNoGroup')(function* resolveNoGroup(
  resolutionInput: Extract<PriceGroupFallbackResolutionInput, { readonly _tag: 'ASSIGNED' | 'GUEST' | 'OWNER_NONE' }>,
  basis: PriceGroupInterpretationBasis,
  lookup: PriceGroupFallbackExactLookupPort,
  groupAbsence?: Extract<PriceGroupFallbackExactLookupResult, { readonly _tag: 'ABSENT' }>,
) {
  const request = noGroupRequest(basis, resolutionInput.effectiveAt);
  const decoded = yield* lookupExact(request, lookup);
  if (Option.isNone(decoded)) {
    return indeterminate(resolutionInput, 'OWNER_STATE_UNVERIFIABLE');
  }
  const result = decoded.value;
  return Match.value(result).pipe(
    Match.tag('FOUND', (usedPrice) =>
      Match.value(resolutionInput).pipe(
        Match.tag('ASSIGNED', (assigned) =>
          groupAbsence === undefined
            ? indeterminate(assigned, 'OWNER_STATE_UNVERIFIABLE')
            : ({
                _tag: 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE',
                discountAudience: assigned.interpretation.discountAudience,
                groupAbsence,
                resolutionInput: assigned,
                usedPrice,
              } satisfies PriceGroupFallbackResolution),
        ),
        Match.tag('OWNER_NONE', (ownerNone) => ({
          _tag: 'NO_GROUP_NONE' as const,
          discountAudience: ownerNone.interpretation.discountAudience,
          resolutionInput: ownerNone,
          usedPrice,
        })),
        Match.tag('GUEST', (guest) => ({
          _tag: 'NO_GROUP_GUEST' as const,
          discountAudience: { kind: 'NONE' as const },
          resolutionInput: guest,
          usedPrice,
        })),
        Match.exhaustive,
      ),
    ),
    Match.tag('ABSENT', (noGroupAbsence) =>
      groupAbsence === undefined
        ? ({ _tag: 'NO_APPLICABLE_PRICE', noGroupAbsence, resolutionInput } satisfies PriceGroupFallbackResolution)
        : ({
            _tag: 'NO_APPLICABLE_PRICE',
            groupAbsence,
            noGroupAbsence,
            resolutionInput,
          } satisfies PriceGroupFallbackResolution),
    ),
    Match.tag('CONFLICT', (terminal) => mapTerminalLookup(resolutionInput, terminal)),
    Match.tag('INVALID', (terminal) => mapTerminalLookup(resolutionInput, terminal)),
    Match.tag('UNAVAILABLE', (terminal) => mapTerminalLookup(resolutionInput, terminal)),
    Match.tag('UNVERIFIABLE', (terminal) => mapTerminalLookup(resolutionInput, terminal)),
    Match.exhaustive,
  );
});

const resolveAssigned = Effect.fn('PriceGroupFallback.resolveAssigned')(function* resolveAssigned(
  resolutionInput: Extract<PriceGroupFallbackResolutionInput, { readonly _tag: 'ASSIGNED' }>,
  lookup: PriceGroupFallbackExactLookupPort,
) {
  const request = assignedGroupRequest(resolutionInput);
  const decoded = yield* lookupExact(request, lookup);
  if (Option.isNone(decoded)) {
    return indeterminate(resolutionInput, 'OWNER_STATE_UNVERIFIABLE');
  }
  const result = decoded.value;
  return yield* Match.value(result).pipe(
    Match.tag('FOUND', (usedPrice) =>
      Effect.succeed({
        _tag: 'GROUP_PRICE' as const,
        discountAudience: resolutionInput.interpretation.discountAudience,
        resolutionInput,
        usedPrice,
      }),
    ),
    Match.tag('ABSENT', (groupAbsence) =>
      resolveNoGroup(resolutionInput, resolutionInput.interpretation.basis, lookup, groupAbsence),
    ),
    Match.tag('CONFLICT', (terminal) => Effect.succeed(mapTerminalLookup(resolutionInput, terminal))),
    Match.tag('INVALID', (terminal) => Effect.succeed(mapTerminalLookup(resolutionInput, terminal))),
    Match.tag('UNAVAILABLE', (terminal) => Effect.succeed(mapTerminalLookup(resolutionInput, terminal))),
    Match.tag('UNVERIFIABLE', (terminal) => Effect.succeed(mapTerminalLookup(resolutionInput, terminal))),
    Match.exhaustive,
  );
});

const resolveBlocked = (
  input: Extract<PriceGroupFallbackResolutionInput, { readonly _tag: 'BLOCKED' }>,
): PriceGroupFallbackResolution =>
  Match.value(input.interpretation).pipe(
    Match.tag('BROKEN', () => ({
      _tag: 'CONFIGURATION_ERROR' as const,
      reason: 'BROKEN_ASSIGNMENT' as const,
      resolutionInput: input,
    })),
    Match.tag('INCONSISTENT', () => ({
      _tag: 'CONFLICT' as const,
      reason: 'INCONSISTENT_ASSIGNMENT' as const,
      resolutionInput: input,
    })),
    Match.tag('UNAVAILABLE', () => indeterminate(input, 'OWNER_STATE_UNAVAILABLE')),
    Match.tag('UNVERIFIABLE', () => indeterminate(input, 'OWNER_STATE_UNVERIFIABLE')),
    Match.exhaustive,
  );

export const makePriceGroupFallbackResolver = (
  lookup: PriceGroupFallbackExactLookupPort,
): PriceGroupFallbackResolverService =>
  PriceGroupFallbackResolver.of({
    resolve: Effect.fn('PriceGroupFallback.resolve')(function* resolve(input) {
      const exactLookup = PriceGroupFallbackExactLookup.of(lookup);
      return yield* Match.value(input).pipe(
        Match.tag('ASSIGNED', (assigned) => resolveAssigned(assigned, exactLookup)),
        Match.tag('OWNER_NONE', (ownerNone) => resolveNoGroup(ownerNone, ownerNone.interpretation.basis, exactLookup)),
        Match.tag('GUEST', (guest) => resolveNoGroup(guest, guest.basis, exactLookup)),
        Match.tag('BLOCKED', (blocked) => Effect.succeed(resolveBlocked(blocked))),
        Match.exhaustive,
      );
    }),
  });
