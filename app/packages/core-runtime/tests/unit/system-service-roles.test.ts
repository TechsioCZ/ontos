import { describe, expect, it } from 'effect-rstest';

import { isSystemServiceRoleKey } from '../../src/auth/system-service-roles.ts';

describe('system service roles', () => {
  it('recognises the read-only warm-up role of every demo company', () => {
    for (const company of ['obchod', 'najempark', 'hanak', 'kavarna', 'akros']) {
      expect(isSystemServiceRoleKey(`warmup-${company}-reader`)).toBe(true);
    }
  });

  it('never hides a person because of an ordinary or agent role', () => {
    for (const roleKey of [
      'admin',
      'sales',
      'crm-sales',
      'external-business',
      'agent:warmup',
      'warmup',
      'warmup-reader',
    ]) {
      expect(isSystemServiceRoleKey(roleKey)).toBe(false);
    }
  });
});
