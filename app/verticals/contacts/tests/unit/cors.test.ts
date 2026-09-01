import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CONTACTS_SHELL_ORIGIN,
  contactsCorsAllowedOrigins,
  resolveContactsShellOrigin,
} from '../../shared/cors.ts';

test('preserves configured Shell origins and falls back for bound non-string values', () => {
  assert.equal(resolveContactsShellOrigin('https://shell.ontos.test'), 'https://shell.ontos.test');
  assert.equal(resolveContactsShellOrigin(), DEFAULT_CONTACTS_SHELL_ORIGIN);
  assert.equal(resolveContactsShellOrigin(3020), DEFAULT_CONTACTS_SHELL_ORIGIN);
  assert.equal(
    resolveContactsShellOrigin({ origin: 'https://shell.ontos.test' }),
    DEFAULT_CONTACTS_SHELL_ORIGIN,
  );
});

test('expands localhost origins without changing remote origins', () => {
  assert.deepEqual(contactsCorsAllowedOrigins('http://localhost:3020'), [
    'http://localhost:3020',
    'http://127.0.0.1:3020',
  ]);
  assert.deepEqual(contactsCorsAllowedOrigins('https://shell.ontos.test/path'), [
    'https://shell.ontos.test',
  ]);
});
