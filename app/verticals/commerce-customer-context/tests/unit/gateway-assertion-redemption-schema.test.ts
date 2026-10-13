import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import {
  COMMERCE_CUSTOMER_CONTEXT_GATEWAY_SCHEMA_NAME,
  gatewayAssertionRedemptions,
} from '../../src/database/gateway-assertion-schema.ts';
import { COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY } from '../../src/database/schema.ts';

it('keeps gateway replay evidence in its own schema, keyed by issuer, audience and jti', () => {
  const config = getTableConfig(gatewayAssertionRedemptions);
  expect(config.schema).toBe(COMMERCE_CUSTOMER_CONTEXT_GATEWAY_SCHEMA_NAME);
  expect(config.name).toBe('gateway_assertion_redemptions');
  expect(config.primaryKeys.flatMap(({ columns }) => columns.map(({ name }) => name))).toStrictEqual([
    'issuer',
    'audience',
    'jti',
  ]);
  expect(config.indexes.map(({ config: index }) => index.name)).toStrictEqual(['ccc_gateway_redemption_expiry']);
  // The owner schema stays routine-only for the runtime role; replay evidence is not part of it.
  expect(COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY).not.toContain('gateway_assertion_redemptions');
});
