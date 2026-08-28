import assert from 'node:assert/strict';
import test from 'node:test';
import { compareProjectsCatalog, expectedProjectsTableCatalog } from '../../src/db/catalog.ts';

test('reports exact Projects catalog differences', () => {
  assert.deepEqual(expectedProjectsTableCatalog, ['projects.contacts', 'projects.customers']);
  assert.deepEqual(compareProjectsCatalog(['projects.contacts']), {
    missing: ['projects.customers'],
    unexpected: [],
  });
  assert.deepEqual(
    compareProjectsCatalog(['projects.contacts', 'projects.customers', 'projects.unexpected']),
    {
      missing: [],
      unexpected: ['projects.unexpected'],
    },
  );
});
