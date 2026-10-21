import { Effect, Exit, Option } from 'effect';
import { expect, test } from 'effect-rstest';

import {
  CONNECTION_SCOPE_REASON_CODE,
  connectionScopePolicy,
  isConnectionReadAllowed,
  isConnectionWriteAllowed,
} from '../../src/auth/oauth-connection-scope.ts';

const sessionPrincipal = { authMethod: 'session' } as never;
const connectionPrincipal = (
  writePolicy: 'approval' | 'direct' | 'read_only',
  modules: 'all' | readonly { access: 'read' | 'write'; moduleId: string }[],
) => ({ authMethod: 'oauth_connection', connection: { modules, writePolicy } }) as never;

test('session principals are unaffected by connection scope', () => {
  expect(isConnectionReadAllowed(sessionPrincipal, 'demo.crm')).toBe(true);
  expect(isConnectionWriteAllowed(sessionPrincipal, 'demo.crm')).toBe(true);
});

test('connection reads are limited to granted modules', () => {
  const principal = connectionPrincipal('read_only', [{ access: 'read', moduleId: 'work.tasks' }]);
  expect(isConnectionReadAllowed(principal, 'work.tasks')).toBe(true);
  expect(isConnectionReadAllowed(principal, 'demo.crm')).toBe(false);
  expect(isConnectionWriteAllowed(principal, 'work.tasks')).toBe(false);
});

test('direct write requires policy direct and module write access', () => {
  const principal = connectionPrincipal('direct', [{ access: 'write', moduleId: 'work.tasks' }]);
  expect(isConnectionWriteAllowed(principal, 'work.tasks')).toBe(true);
  expect(isConnectionWriteAllowed(principal, 'demo.crm')).toBe(false);
});

test('approval policy never allows direct writes', () => {
  const principal = connectionPrincipal('approval', [{ access: 'write', moduleId: 'work.tasks' }]);
  expect(isConnectionWriteAllowed(principal, 'work.tasks')).toBe(false);
});

test('read_only policy denies writes even for all modules', () => {
  const principal = connectionPrincipal('read_only', 'all');
  expect(isConnectionReadAllowed(principal, 'demo.crm')).toBe(true);
  expect(isConnectionWriteAllowed(principal, 'demo.crm')).toBe(false);
});

test('direct policy with all modules allows writes', () => {
  expect(isConnectionWriteAllowed(connectionPrincipal('direct', 'all'), 'demo.crm')).toBe(true);
});

test('connection scope policy denies writes with connection_scope reason', () => {
  const principal = connectionPrincipal('approval', [{ access: 'write', moduleId: 'demo.crm' }]);
  const exit = Effect.runSyncExit(
    connectionScopePolicy.evaluate({
      action: { actionKey: 'x', owningModuleKey: 'demo.crm', schemaVersion: '1' },
      payload: undefined,
      principal,
      target: {},
      transport: { correlationId: 'c' },
    } as never),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Option.getOrUndefined(Exit.findErrorOption(exit)) as { reasonCode?: string } | undefined;
    expect(error?.reasonCode).toBe(CONNECTION_SCOPE_REASON_CODE);
  }
});
