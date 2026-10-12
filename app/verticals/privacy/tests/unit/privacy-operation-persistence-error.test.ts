import { Cause } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { privacyOperationPersistenceFailureCode } from '../../src/persistence/privacy-operation-persistence-error.ts';

describe('Privacy persistence failure classification', () => {
  it('maps known owner uniqueness violations to conflicts through native Cause wrappers', () => {
    for (const constraint of [
      'privacy_consent_decisions_idempotency_uk',
      'privacy_dsr_owner_tasks_invocation_uk',
      'privacy_retention_rules_version_uk',
    ]) {
      const failure = Cause.fail(new Error('wrapped database failure', { cause: { code: '23505', constraint } }));
      expect(privacyOperationPersistenceFailureCode(failure)).toBe('privacy_operation_conflict');
    }
  });

  it('preserves unknown constraints, missing metadata and other SQL failures as persistence failures', () => {
    for (const failure of [
      { code: '23505', constraint: 'privacy_unrecognized_future_uk' },
      { code: '23505', constraint: 'another_owner_idempotency_uk' },
      { code: '23505' },
      { code: '23503', constraint: 'privacy_consent_decisions_idempotency_uk' },
      new Error('database unavailable'),
    ]) {
      expect(privacyOperationPersistenceFailureCode(failure)).toBe('privacy_operation_persistence_unavailable');
    }
  });
});
