import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CRM_SHELL_ORIGIN,
  crmCorsAllowedOrigins,
  resolveCrmShellOrigin,
} from '../../shared/cors.ts';

test('preserves configured Shell origins and falls back for bound non-string values', () => {
  assert.equal(resolveCrmShellOrigin('https://shell.ontos.test'), 'https://shell.ontos.test');
  assert.equal(resolveCrmShellOrigin(), DEFAULT_CRM_SHELL_ORIGIN);
  assert.equal(resolveCrmShellOrigin(3020), DEFAULT_CRM_SHELL_ORIGIN);
  assert.equal(
    resolveCrmShellOrigin({ origin: 'https://shell.ontos.test' }),
    DEFAULT_CRM_SHELL_ORIGIN,
  );
});

test('expands localhost origins without changing remote origins', () => {
  assert.deepEqual(crmCorsAllowedOrigins('http://localhost:3020'), [
    'http://localhost:3020',
    'http://127.0.0.1:3020',
  ]);
  assert.deepEqual(crmCorsAllowedOrigins('https://shell.ontos.test/path'), [
    'https://shell.ontos.test',
  ]);
});
