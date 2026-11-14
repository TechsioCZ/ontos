import { Cause, Effect, Exit, Logger, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { observeShellSearchProvider, shellSearchFailureIdentity } from '../../api/modules/shell-search-diagnostics.ts';

it('keeps only bounded failure identities and the known HTTP problem code', () => {
  const identity = shellSearchFailureIdentity({
    _tag: 'ShellProviderUnavailableError',
    cause: {
      body: JSON.stringify({ detail: 'private email@example.test token SQL', error: 'owner_unavailable' }),
      status: 503,
    },
    message: 'private query',
  });
  expect(identity).toEqual({
    search_cause_tag: 'none',
    search_failure_code: 'none',
    search_failure_tag: 'ShellProviderUnavailableError',
    search_http_status: 503,
    search_problem_code: 'owner_unavailable',
  });
  expect(JSON.stringify(identity)).not.toContain('private');
});

it('does not walk driver causes or expose invalid tokens and large response bodies', () => {
  const identity = shellSearchFailureIdentity({
    _tag: 'SELECT private_data',
    cause: {
      _tag: 'ModuleReleaseTransportError',
      body: 'private'.repeat(2000),
      cause: { _tag: 'SqlError', code: '42501', sql: 'secret SQL' },
      status: 500,
    },
  });
  expect(identity).toEqual({
    search_cause_tag: 'none',
    search_failure_code: 'none',
    search_failure_tag: 'untyped',
    search_http_status: 0,
    search_problem_code: 'none',
  });
  expect(JSON.stringify(identity)).not.toContain('42501');
  expect(JSON.stringify(identity)).not.toContain('private');
});

it('reads one declared provider wrapper but never its nested driver error', () => {
  const identity = shellSearchFailureIdentity({
    _tag: 'ShellProviderUnavailableError',
    cause: {
      _tag: 'ModuleReleaseTransportError',
      cause: { _tag: 'SqlError', code: '42501', sql: 'private SQL' },
    },
  });
  expect(identity.search_cause_tag).toBe('ModuleReleaseTransportError');
  expect(JSON.stringify(identity)).not.toContain('42501');
  expect(JSON.stringify(identity)).not.toContain('private');
});

it('does not decode an oversized body in a known provider envelope', () => {
  const identity = shellSearchFailureIdentity({
    _tag: 'ShellProviderUnavailableError',
    cause: {
      body: JSON.stringify({ code: 'do_not_decode', detail: 'private'.repeat(2000) }),
      status: 503,
    },
  });
  expect(identity.search_http_status).toBe(503);
  expect(identity.search_problem_code).toBe('none');
  expect(JSON.stringify(identity)).not.toContain('private');
});

it.effect('logs a failed provider phase without changing its failure or logging successful attempts', () =>
  Effect.gen(function* providerDiagnosticsTest() {
    const entries: string[] = [];
    const logger = Logger.layer([
      Logger.make((options) => {
        entries.push(JSON.stringify(Logger.formatStructured.log(options)));
      }),
    ]);
    const observe = observeShellSearchProvider({
      moduleId: 'demo.crm',
      phase: 'owner',
      searchKey: 'demo.crm.clients',
    });
    expect(yield* Effect.succeed(42).pipe(observe, Effect.provide(logger))).toBe(42);
    expect(entries).toEqual([]);
    const failure = { _tag: 'ReadHandlerUnavailable', code: 'read_handler_unavailable', reason: 'secret record' };
    const exit = yield* Effect.fail(failure).pipe(observe, Effect.provide(logger), Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()).toEqual(Option.some(failure));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('demo.crm.clients');
    expect(entries[0]).toContain('ReadHandlerUnavailable');
    expect(entries[0]).toContain('search_duration_ms');
    expect(entries[0]).not.toContain('secret record');
  }),
);
