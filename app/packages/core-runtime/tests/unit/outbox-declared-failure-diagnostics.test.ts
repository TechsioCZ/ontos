import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  OutboxDeclaredFailureIdentitySchema,
  outboxDeclaredFailureDiagnostics,
} from '../../src/outbox/declared-failure-diagnostics.ts';

const decode = Schema.decodeUnknownResult(OutboxDeclaredFailureIdentitySchema);

it('retains declared owner identity without provider or business details', () => {
  const diagnostic = outboxDeclaredFailureDiagnostics(
    decode({
      _tag: 'MarketSearchUnavailable',
      cause: { message: 'secret password and private SQL' },
      code: 'market_search_unavailable',
      payload: { password: 'secret' },
      reason: 'private customer name',
      stack: 'secret stack',
    }),
  );
  expect(diagnostic).toEqual({
    declared_failure_code: 'market_search_unavailable',
    declared_failure_tag: 'MarketSearchUnavailable',
  });
  expect(JSON.stringify(diagnostic)).not.toContain('secret');
  expect(JSON.stringify(diagnostic)).not.toContain('customer');
});
it('refuses multiline, oversized, and unstructured identities', () => {
  expect(outboxDeclaredFailureDiagnostics(decode({ _tag: 'secret\nnew line' })).declared_failure_tag).toBe('untyped');
  expect(outboxDeclaredFailureDiagnostics(decode({ _tag: 'x'.repeat(129) })).declared_failure_tag).toBe('untyped');
  expect(outboxDeclaredFailureDiagnostics(decode('raw secret message'))).toEqual({
    declared_failure_code: 'none',
    declared_failure_tag: 'untyped',
  });
  expect(outboxDeclaredFailureDiagnostics(decode({ _tag: 'OwnerFailure' }))).toEqual({
    declared_failure_code: 'none',
    declared_failure_tag: 'OwnerFailure',
  });
});
