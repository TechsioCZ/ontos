import { describe, expect, it } from 'effect-rstest';

import { safeCauseOf } from '../../src/domain/intake/safe-cause.ts';

/**
 * What a typed "unavailable" error may keep of the failure it replaces (#1401): only its own kind and, for PostgreSQL,
 * the sanitized SQLSTATE and constraint. The native-database proof that a real failed statement leaks nothing is in
 * `tests/integration/cause-redaction.test.ts`.
 */
describe('A typed unavailable error keeps only the safe kind of its cause', () => {
  it('keeps the failure kind and the sanitized SQLSTATE and constraint, nothing else', () => {
    const databaseFailure = Object.assign(new Error('Failed query: insert ... params: customer-1,p***@example.test'), {
      cause: { code: '23505', constraint: 'communications_intents_key_uk' },
      name: 'DrizzleQueryError',
    });
    expect(safeCauseOf(databaseFailure)).toEqual({
      constraint: 'communications_intents_key_uk',
      kind: 'DrizzleQueryError',
      sqlState: '23505',
    });
  });

  it('names a tagged failure by its tag and drops its fields; a value that names nothing is just unknown', () => {
    expect(safeCauseOf({ _tag: 'SomeOwnerFailure', recipient: 'customer-1' })).toEqual({ kind: 'SomeOwnerFailure' });
    expect(safeCauseOf('p***@example.test')).toEqual({ kind: 'unknown' });
  });
});
