import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { lookupPrivacyOwnerInventory } from '../../shared/domain/owner-inventory.ts';
import type {
  PrivacyOwnerApplicationComposition,
  ProcessingActivityOwnerInventoryInput,
} from '../../shared/domain/owner-inventory.ts';
import { PersonalDataCoverageSchema } from '../../shared/domain/processing-coverage.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const coverage = Schema.decodeUnknownSync(PersonalDataCoverageSchema)({
  dataCategoryRef: {
    moduleId: 'privacy.core',
    resourceId: 'category-1',
    resourceType: 'privacy.core.data-category',
    tenantId,
  },
  ownerCapability: 'accounts',
  recordContentScope: 'account-record',
  systemOfRecordRef: {
    moduleId: 'accounts.core',
    resourceId: 'accounts',
    resourceType: 'accounts.core.account',
    tenantId,
  },
});
const activity: ProcessingActivityOwnerInventoryInput = {
  activityRef: {
    resourceId: 'activity-1',
    tenantId,
  },
  dataCoverage: [coverage],
};
const composition: PrivacyOwnerApplicationComposition = { modules: [{ moduleId: 'accounts.core' }] };

describe('Privacy owner inventory', () => {
  it('keeps an empty result distinct from incomplete coverage', () => {
    const result = lookupPrivacyOwnerInventory({
      activity,
      composition,
      moduleStates: new Map([['accounts.core', 'active']]),
      observations: [
        { moduleId: 'accounts.core', observedAt: '2026-01-01T00:00:00Z', outcome: 'NO_DATA', resourceRefs: [] },
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.entries[0]?.status).toBe('NO_DATA');
  });

  it('does not turn an empty search or unavailable owner into NO_DATA', () => {
    const result = lookupPrivacyOwnerInventory({
      activity,
      composition,
      moduleStates: new Map([['accounts.core', 'active']]),
    });
    expect(result.complete).toBe(false);
    expect(result.entries[0]?.status).toBe('UNCHECKED');
    const unavailable = lookupPrivacyOwnerInventory({
      activity,
      availability: new Map([['accounts.core', 'UNAVAILABLE']]),
      composition,
      moduleStates: new Map([['accounts.core', 'active']]),
      observations: [],
    });
    expect(unavailable.entries[0]?.status).toBe('UNAVAILABLE');
  });

  it('reports missing and disabled deployed owners separately', () => {
    expect(lookupPrivacyOwnerInventory({ activity, composition: { modules: [] } }).entries[0]?.status).toBe('MISSING');
    expect(
      lookupPrivacyOwnerInventory({ activity, composition, moduleStates: new Map([['accounts.core', 'inactive']]) })
        .entries[0]?.status,
    ).toBe('DISABLED');
  });

  it('does not satisfy an owner requirement with an observation from another owner', () => {
    const result = lookupPrivacyOwnerInventory({
      activity,
      composition,
      moduleStates: new Map([['accounts.core', 'active']]),
      observations: [
        { moduleId: 'billing.core', observedAt: '2026-01-01T00:00:00Z', outcome: 'FOUND', resourceRefs: ['invoice-1'] },
      ],
    });
    expect(result.entries[0]?.status).toBe('UNCHECKED');
    expect(result.complete).toBe(false);
  });
});
