import { Cause } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { safeCauseOf, safeCauseSummaryOf } from '../../src/domain/intake/safe-cause.ts';

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

  it('summarizes a whole Cause by the safe kind of each reason, never by what a defect or failure holds', () => {
    const secret = 'p***@example.test customer-1 Bearer-secret-token';
    const defect = Object.assign(new Error(`adapter failed for ${secret}`), { name: 'OwnerAdapterDefect' });
    const summary = safeCauseSummaryOf(
      Cause.combine(
        Cause.die(defect),
        Cause.combine(Cause.fail({ _tag: 'OwnerFailure', recipient: secret }), Cause.interrupt()),
      ),
    );

    expect(summary.reasons.map(({ kind, type }) => [type, kind])).toEqual([
      ['Die', 'OwnerAdapterDefect'],
      ['Fail', 'OwnerFailure'],
      ['Interrupt', 'interrupt'],
    ]);
    expect(JSON.stringify(summary)).not.toContain('customer-1');
    expect(JSON.stringify(summary)).not.toContain('Bearer-secret-token');
  });
});
