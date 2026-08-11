import assert from 'node:assert/strict';
import test from 'node:test';
import { isTable } from 'drizzle-orm';
import * as schemaExports from '../../src/db/schema.ts';
import { CRM_SCHEMA_NAME, CRM_TABLE_INVENTORY, crmSchema } from '../../src/db/schema.ts';

test('owns the dedicated CRM schema without introducing entity tables', () => {
  assert.equal(crmSchema.schemaName, CRM_SCHEMA_NAME);
  assert.deepEqual(CRM_TABLE_INVENTORY, []);
  assert.deepEqual(Object.values(schemaExports).filter(isTable), []);
});
