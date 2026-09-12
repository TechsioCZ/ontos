import { Effect, Match } from 'effect';
import {
  CustomerPriceGroupAssignmentNotFound,
  CustomerPriceGroupProfileNotFound,
  CustomerPriceGroupRemovalConflict,
  CustomerPriceGroupRevisionConflict,
  CustomerPriceGroupRetroactiveScheduleRejected,
} from '../../shared/domain/price-group-errors.ts';
import type { RemoveCustomerPriceGroupStoreResult } from '../../shared/domain/price-group-ports.ts';

interface PriceGroupRemovalErrorReasons {
  readonly profileMismatch: string;
  readonly profileNotFound: string;
}

export const interpretPriceGroupRemovalResult = (
  stored: RemoveCustomerPriceGroupStoreResult,
  reasons: PriceGroupRemovalErrorReasons,
) =>
  Match.value(stored).pipe(
    Match.tag('removed', (removed) => Effect.succeed(removed)),
    Match.tag('assignment_not_found', () =>
      Effect.fail(
        new CustomerPriceGroupAssignmentNotFound({
          code: 'customer_price_group_assignment_not_found',
          reason: 'The exact PriceGroup assignment does not exist',
        }),
      ),
    ),
    Match.tag('profile_not_found', () =>
      Effect.fail(
        new CustomerPriceGroupProfileNotFound({
          code: 'customer_price_group_profile_not_found',
          reason: reasons.profileNotFound,
        }),
      ),
    ),
    Match.tag('profile_mismatch', () =>
      Effect.fail(
        new CustomerPriceGroupRemovalConflict({
          code: 'customer_price_group_removal_conflict',
          reason: reasons.profileMismatch,
        }),
      ),
    ),
    Match.tag('removal_conflict', () =>
      Effect.fail(
        new CustomerPriceGroupRemovalConflict({
          code: 'customer_price_group_removal_conflict',
          reason: 'The requested effective removal conflicts with the assignment period',
        }),
      ),
    ),
    Match.tag('retroactive_schedule', () =>
      Effect.fail(
        new CustomerPriceGroupRetroactiveScheduleRejected({
          code: 'customer_price_group_retroactive_schedule_rejected',
          reason: 'The removal became retroactive before it could be persisted',
        }),
      ),
    ),
    Match.tag('revision_conflict', ({ currentRevision }) =>
      Effect.fail(
        new CustomerPriceGroupRevisionConflict({
          code: 'customer_price_group_revision_conflict',
          currentRevision,
          reason: 'The assignment changed after it was read',
        }),
      ),
    ),
    Match.exhaustive,
  );
