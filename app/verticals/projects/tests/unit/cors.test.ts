import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PROJECTS_SHELL_ORIGIN,
  projectsCorsAllowedOrigins,
  resolveProjectsShellOrigin,
} from '../../shared/cors.ts';

test('preserves configured Shell origins and falls back for bound non-string values', () => {
  assert.equal(resolveProjectsShellOrigin('https://shell.ontos.test'), 'https://shell.ontos.test');
  assert.equal(resolveProjectsShellOrigin(), DEFAULT_PROJECTS_SHELL_ORIGIN);
  assert.equal(resolveProjectsShellOrigin(3020), DEFAULT_PROJECTS_SHELL_ORIGIN);
  assert.equal(
    resolveProjectsShellOrigin({ origin: 'https://shell.ontos.test' }),
    DEFAULT_PROJECTS_SHELL_ORIGIN,
  );
});

test('expands localhost origins without changing remote origins', () => {
  assert.deepEqual(projectsCorsAllowedOrigins('http://localhost:3020'), [
    'http://localhost:3020',
    'http://127.0.0.1:3020',
  ]);
  assert.deepEqual(projectsCorsAllowedOrigins('https://shell.ontos.test/path'), [
    'https://shell.ontos.test',
  ]);
});
