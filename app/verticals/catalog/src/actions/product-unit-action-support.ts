import { Effect, Match } from 'effect';

import { ProductUnitActionError } from '../../shared/actions/product-unit-contract.ts';
import type { ProductUnitMutationOutcome } from '../persistence/product-unit-persistence.ts';
import { productUnitPersistenceForScope } from '../persistence/product-unit-persistence.ts';
import { productUnitTargetBasisForScope } from '../persistence/product-unit-target-basis.ts';

export const productUnitPersistenceServiceFactory = (
  transaction: Parameters<typeof productUnitPersistenceForScope>[0],
  scope: Parameters<typeof productUnitPersistenceForScope>[1],
) =>
  Effect.succeed(
    productUnitPersistenceForScope(transaction, scope, productUnitTargetBasisForScope(transaction, scope)),
  );

export const mapProductUnitPersistenceError = () =>
  new ProductUnitActionError({
    code: 'product_unit_unavailable',
    reason: 'Authoritative Product Unit persistence or Current basis is unavailable',
  });

export const resolveProductUnitMutation = (outcome: ProductUnitMutationOutcome) =>
  Match.value(outcome).pipe(
    Match.whenOr(
      { _tag: 'created' },
      { _tag: 'revised' },
      { _tag: 'retired' },
      { _tag: 'divisibility_set' },
      ({ ruleRevision, targetDivisibility, unit }) =>
        Effect.succeed(
          targetDivisibility === undefined ? { ruleRevision, unit } : { ruleRevision, targetDivisibility, unit },
        ),
    ),
    Match.tag('invalid', ({ reason }) =>
      Effect.fail(new ProductUnitActionError({ code: 'product_unit_invalid', reason })),
    ),
    Match.tag('not_found', () =>
      Effect.fail(
        new ProductUnitActionError({
          code: 'product_unit_invalid',
          reason: 'Product Unit was not found in the trusted Tenant',
        }),
      ),
    ),
    Match.tag('stale', () =>
      Effect.fail(
        new ProductUnitActionError({ code: 'product_unit_stale', reason: 'Product Unit Current revision changed' }),
      ),
    ),
    Match.exhaustive,
  );
