import { Effect, Match } from 'effect';

import { BrandActionError } from '../../shared/actions/brand-mutations.ts';
import type { BrandMutationOutcome, ProductBrandMutationOutcome } from '../persistence/brand-persistence.ts';
import { brandPersistenceForScope } from '../persistence/brand-persistence.ts';

export const brandPersistenceServiceFactory = (...args: Parameters<typeof brandPersistenceForScope>) =>
  Effect.succeed(brandPersistenceForScope(...args));

export const mapBrandPersistenceError = () =>
  new BrandActionError({ code: 'brand_unavailable', reason: 'Authoritative Brand persistence is unavailable' });

type MutationOutcome = BrandMutationOutcome | ProductBrandMutationOutcome;

export function resolveBrandMutation(
  outcome: BrandMutationOutcome,
): Effect.Effect<Extract<BrandMutationOutcome, { _tag: 'applied' }>['result'], BrandActionError>;
export function resolveBrandMutation(
  outcome: ProductBrandMutationOutcome,
): Effect.Effect<Extract<ProductBrandMutationOutcome, { _tag: 'applied' }>['result'], BrandActionError>;
export function resolveBrandMutation(outcome: MutationOutcome) {
  return Match.value(outcome).pipe(
    Match.tag('applied', ({ result }) => Effect.succeed(result)),
    Match.tag('invalid', ({ reason }) => Effect.fail(new BrandActionError({ code: 'brand_invalid', reason }))),
    Match.tag('stale', () =>
      Effect.fail(new BrandActionError({ code: 'brand_stale', reason: 'Current revision changed' })),
    ),
    Match.tag('not_found', () =>
      Effect.fail(
        new BrandActionError({ code: 'brand_not_found', reason: 'Resource was not found in the trusted Tenant' }),
      ),
    ),
    Match.exhaustive,
  );
}
