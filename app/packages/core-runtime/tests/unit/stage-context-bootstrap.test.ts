import assert from 'node:assert/strict';
import test from 'node:test';
import { STAGE_CONTEXTS } from '../../src/install/stage-context-bootstrap.ts';

void test('defines the exact Techsio and Siampark stage contexts', () => {
  assert.deepEqual(STAGE_CONTEXTS, {
    siampark: {
      authBindingId: '73000000-0000-4000-8000-000000000002',
      defaultLocale: 'cs',
      legalEntityId: '71000000-0000-4000-8000-000000000002',
      legalName: 'Siampark',
      moduleId: 'party.registry',
      moduleStateId: '74000000-0000-4000-8000-000000000002',
      principalDisplayName: 'Siampark 01',
      principalId: '72000000-0000-4000-8000-000000000002',
      registrationCountry: 'CZ',
      registrationNumber: 'DEMO-SIAMPARK',
      tenantId: '70000000-0000-4000-8000-000000000002',
      tenantName: 'Siampark',
      tenantSlug: 'siampark',
    },
    techsio: {
      authBindingId: '73000000-0000-4000-8000-000000000001',
      defaultLocale: 'cs',
      legalEntityId: '71000000-0000-4000-8000-000000000001',
      legalName: 'TechsioCZ',
      moduleId: 'party.registry',
      moduleStateId: '74000000-0000-4000-8000-000000000001',
      principalDisplayName: 'Techsio Demo',
      principalId: '72000000-0000-4000-8000-000000000001',
      registrationCountry: 'CZ',
      registrationNumber: 'DEMO-TECHSIOCZ',
      tenantId: '70000000-0000-4000-8000-000000000001',
      tenantName: 'Techsio',
      tenantSlug: 'techsio',
    },
  });
});
