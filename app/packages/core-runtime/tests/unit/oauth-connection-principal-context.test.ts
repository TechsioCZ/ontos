import { Exit, Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';

const decode = Schema.decodeUnknownExit(TrustedPrincipalContextSchema);

const grantId = '30000000-0000-4000-8000-000000000001';
const base = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: `oauth-grant:${grantId}`,
  authMethod: 'oauth_connection',
  connection: {
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    clientName: 'Claude Code',
    grantId,
    modules: [{ access: 'write', moduleId: 'siampark.work' }],
    writePolicy: 'direct',
  },
  legalEntityId: '71000000-0000-4000-8000-000000000021',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
};

const sessionContext = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:s1',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
};

test('valid oauth connection context with module list is accepted', () => {
  expect(Exit.isSuccess(decode(base))).toBe(true);
});

test('valid oauth connection context with all modules is accepted', () => {
  expect(Exit.isSuccess(decode({ ...base, connection: { ...base.connection, modules: 'all' } }))).toBe(true);
});

test('oauth connection context with a distinct delegating principal is accepted', () => {
  expect(
    Exit.isSuccess(decode({ ...base, delegatedByPrincipalId: '20000000-0000-4000-8000-000000000002' })),
  ).toBe(true);
});

test('oauth connection context delegated by its own principal is rejected', () => {
  expect(Exit.isSuccess(decode({ ...base, delegatedByPrincipalId: base.principalId }))).toBe(false);
});

test('oauth connection context without connection data is rejected', () => {
  const { connection: _connection, ...withoutConnection } = base;
  expect(Exit.isSuccess(decode(withoutConnection))).toBe(false);
});

test('oauth connection context with a mismatched grant reference is rejected', () => {
  expect(Exit.isSuccess(decode({ ...base, authContextRef: 'oauth-grant:other' }))).toBe(false);
});

test('oauth connection context without a legal entity is rejected', () => {
  const { legalEntityId: _legalEntityId, ...withoutLegalEntity } = base;
  expect(Exit.isSuccess(decode(withoutLegalEntity))).toBe(false);
});

test('oauth connection context with an impersonator is rejected', () => {
  expect(
    Exit.isSuccess(decode({ ...base, impersonatedByPrincipalId: '20000000-0000-4000-8000-000000000003' })),
  ).toBe(false);
});

test('session context carrying connection data is rejected', () => {
  expect(Exit.isSuccess(decode({ ...sessionContext, connection: base.connection }))).toBe(false);
});

test('session context without connection data is accepted', () => {
  expect(Exit.isSuccess(decode(sessionContext))).toBe(true);
});
