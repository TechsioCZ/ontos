import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCrmCatalog, expectedCrmTableCatalog } from '../../src/db/catalog.ts';

test('reports exact CRM catalog differences', () => {
  assert.deepEqual(expectedCrmTableCatalog, ['crm.contacts', 'crm.customers']);
  assert.deepEqual(compareCrmCatalog(['crm.contacts']), {
    missing: ['crm.customers'],
    unexpected: [],
  });
  assert.deepEqual(compareCrmCatalog(['crm.contacts', 'crm.customers', 'crm.unexpected']), {
    missing: [],
    unexpected: ['crm.unexpected'],
  });
});
