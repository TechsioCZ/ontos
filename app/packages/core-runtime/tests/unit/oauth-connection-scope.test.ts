import { Effect, Exit, Option, Schema } from 'effect';
import { expect, it, test } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';

import {
  CONNECTION_SCOPE_REASON_CODE,
  connectionScopePolicy,
  isConnectionReadAllowed,
  isConnectionWriteAllowed,
} from '../../src/auth/oauth-connection-scope.ts';

const decodePrincipal = Schema.decodeSync(TrustedPrincipalContextSchema);
const readOf = (owningModuleKey: string) => ({ owningModuleKey, readKey: `${owningModuleKey}.records` });
const sessionPrincipal = decodePrincipal({
  authBindingId: '00000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:connection-scope-test',
  authMethod: 'session',
  principalId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000003',
});
const connectionPrincipal = (
  writePolicy: 'approval' | 'direct' | 'read_only',
  modules: 'all' | readonly { access: 'read' | 'write'; moduleId: string }[],
) =>
  decodePrincipal({
    ...sessionPrincipal,
    authContextRef: 'oauth-grant:00000000-0000-4000-8000-000000000004',
    authMethod: 'oauth_connection',
    connection: {
      clientId: 'scope-client',
      clientName: 'Scope test client',
      grantId: '00000000-0000-4000-8000-000000000004',
      modules,
      writePolicy,
    },
    legalEntityId: '00000000-0000-4000-8000-000000000005',
  });

test('session principals are unaffected by connection scope', () => {
  expect(isConnectionReadAllowed(sessionPrincipal, readOf('demo.crm'))).toBe(true);
  expect(isConnectionWriteAllowed(sessionPrincipal, 'demo.crm')).toBe(true);
});

test('connection reads are limited to granted modules', () => {
  const principal = connectionPrincipal('read_only', [{ access: 'read', moduleId: 'work.tasks' }]);
  expect(isConnectionReadAllowed(principal, readOf('work.tasks'))).toBe(true);
  expect(isConnectionReadAllowed(principal, readOf('demo.crm'))).toBe(false);
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
  expect(isConnectionReadAllowed(principal, readOf('demo.crm'))).toBe(true);
  expect(isConnectionWriteAllowed(principal, 'demo.crm')).toBe(false);
});

test('direct policy with all modules allows writes', () => {
  expect(isConnectionWriteAllowed(connectionPrincipal('direct', 'all'), 'demo.crm')).toBe(true);
});

it.effect('connection scope policy denies writes with connection_scope reason', () =>
  Effect.gen(function* connectionScopeDenial() {
    const principal = connectionPrincipal('approval', [{ access: 'write', moduleId: 'demo.crm' }]);
    const exit = yield* Effect.exit(
      connectionScopePolicy.evaluate({
        action: { actionKey: 'x', owningModuleKey: 'demo.crm', schemaVersion: '1' },
        payload: {},
        principal,
        target: {},
        transport: { correlationId: 'c' },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Option.getOrUndefined(Exit.findErrorOption(exit));
      expect(error?.reasonCode).toBe(CONNECTION_SCOPE_REASON_CODE);
    }
  }),
);

const PROPOSAL_QUEUE_READ = { owningModuleKey: 'core.identity', readKey: 'core.identity.agent-proposal-queue' };
const PROPOSAL_ID = '00000000-0000-4000-8000-000000000007';
const insertProposal = (moduleKey: string) => ({
  batchId: '00000000-0000-4000-8000-000000000006',
  instruction: 'Requested',
  operation: 'insert' as const,
  proposals: [
    {
      actionSlug: 'update',
      appId: 'tasks',
      command: { title: 'New' },
      diff: [],
      moduleKey,
      proposalId: PROPOSAL_ID,
      reason: 'Requested',
      risk: 'low' as const,
      summary: 'Update',
      targetLabel: 'Task',
    },
  ],
});
const evaluateScope = (
  principal: ReturnType<typeof connectionPrincipal>,
  actionKey: string,
  payload:
    | ReturnType<typeof insertProposal>
    | { readonly batchId: string; readonly operation: 'claim-approval'; readonly proposalId: string },
  owningModuleKey = 'core.identity',
) =>
  Effect.exit(
    connectionScopePolicy.evaluate({
      action: { actionKey, owningModuleKey, schemaVersion: '1' },
      payload,
      principal,
      target: {},
      transport: { correlationId: 'c' },
    }),
  );

test('only approval connections read their own proposal queue outside the granted modules', () => {
  const modules = [{ access: 'write' as const, moduleId: 'work.tasks' }];
  expect(isConnectionReadAllowed(connectionPrincipal('approval', modules), PROPOSAL_QUEUE_READ)).toBe(true);
  expect(isConnectionReadAllowed(connectionPrincipal('read_only', modules), PROPOSAL_QUEUE_READ)).toBe(false);
  expect(isConnectionReadAllowed(connectionPrincipal('direct', modules), PROPOSAL_QUEUE_READ)).toBe(false);
  expect(
    isConnectionReadAllowed(connectionPrincipal('approval', modules), {
      owningModuleKey: 'core.identity',
      readKey: 'core.identity.people-directory',
    }),
  ).toBe(false);
});

it.effect('an approval connection may insert proposals only for modules it may write', () =>
  Effect.gen(function* proposalInsertScope() {
    const principal = connectionPrincipal('approval', [
      { access: 'write', moduleId: 'work.tasks' },
      { access: 'read', moduleId: 'demo.crm' },
    ]);
    const mutate = 'core.identity.mutate-agent-proposals';
    expect(Exit.isSuccess(yield* evaluateScope(principal, mutate, insertProposal('work.tasks')))).toBe(true);
    expect(Exit.isFailure(yield* evaluateScope(principal, mutate, insertProposal('demo.crm')))).toBe(true);
    const claim = { batchId: '00000000-0000-4000-8000-000000000006', operation: 'claim-approval' as const };
    expect(Exit.isFailure(yield* evaluateScope(principal, mutate, { ...claim, proposalId: PROPOSAL_ID }))).toBe(true);
    expect(Exit.isFailure(yield* evaluateScope(principal, 'core.identity.other', insertProposal('work.tasks')))).toBe(
      true,
    );
    const readOnly = connectionPrincipal('read_only', 'all');
    expect(Exit.isFailure(yield* evaluateScope(readOnly, mutate, insertProposal('work.tasks')))).toBe(true);
  }),
);
