import type { ActionTestPreparationReadScript } from '@app/core-runtime/testing/actions';
import { Effect } from 'effect';

interface PriceGroupProfileInspectionRow {
  readonly counterparty_resource_id: string | null;
  readonly outcome: 'CURRENT' | 'NOT_FOUND';
  readonly profile_state: 'ACTIVE' | 'ARCHIVED' | 'RECONCILIATION_REQUIRED' | 'SUSPENDED' | null;
  readonly revision: number;
}

/** The Assign and Migrate preparation snapshot reads the profile through this exact owner routine. */
export const priceGroupProfilePreparationRead = (
  row: PriceGroupProfileInspectionRow,
): ActionTestPreparationReadScript => ({
  execute: () => Effect.succeed([row]),
  sql: 'select * from "commerce_customer_context"."inspect_price_group_profile"($1::uuid, $2::uuid, $3::text, $4::text, $5::timestamptz, $6::text)',
});

/**
 * Answering "not found" keeps preparation away from the Price Group Catalog; tests that bind their own
 * transaction services then exercise the handler against those services.
 */
export const priceGroupProfileAbsentPreparationRead = priceGroupProfilePreparationRead({
  counterparty_resource_id: null,
  outcome: 'NOT_FOUND',
  profile_state: null,
  revision: 0,
});
