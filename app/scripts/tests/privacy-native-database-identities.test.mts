import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  IdentitySetupRequestSchema,
  IdentitySetupStatusSchema,
  restrictedNativeIdentityMatches,
  setupAddressMatches,
} from '../integration/support/privacy-native-database-identities.mts';

const database = `ontos_test_party_gateway_${'a'.repeat(32)}`;
const request = {
  creatorPid: 123,
  databaseName: database,
  databaseOid: '456',
  systemIdentifier: '789',
  type: 'prepare-privacy-native-identities',
};
const decode = Schema.decodeUnknownSync(IdentitySetupRequestSchema, { onExcessProperty: 'error' });
const expected = { database, host: 'localhost', port: 5432, user: 'shell_gateway_issuer' };
it('accepts only the fixed creator identity setup request and noncredential status', () => {
  expect(decode(request)).toEqual(request);
  for (const delta of [
    { creatorPid: 0 },
    { databaseName: 'ontos' },
    { databaseName: `${database}_foreign` },
    { databaseOid: 'invalid' },
    { systemIdentifier: '' },
    { type: 'execute-sql' },
    { sql: 'select 1' },
    { credentials: 'forbidden' },
    { role: 'party_registry_worker' },
    { manifestRoles: ['ontos_admin'] },
    { PARTY_REGISTRY_WORKER_DATABASE_URL: 'postgres://forbidden@localhost/ontos' },
  ]) {
    expect(() => decode({ ...request, ...delta })).toThrow();
  }
  const status = {
    databaseName: database,
    databaseOid: '456',
    systemIdentifier: '789',
    type: 'privacy-native-identities-prepared',
  };
  expect(Schema.decodeUnknownSync(IdentitySetupStatusSchema)(status)).toEqual(status);
  expect(() =>
    Schema.decodeUnknownSync(IdentitySetupStatusSchema)(
      { ...status, connectionString: 'forbidden' },
      { onExcessProperty: 'error' },
    ),
  ).toThrow();
});
it('refuses foreign target, role aliases and URL identity overrides before setup', () => {
  const canonical = `postgres://shell_gateway_issuer:fixture@localhost:5432/${database}`;
  expect(setupAddressMatches(new URL(canonical), expected)).toBe(true);
  for (const address of [
    canonical.replace(database, 'ontos'),
    canonical.replace('localhost', 'remote.invalid'),
    canonical.replace('5432', '5433'),
    canonical.replace('shell_gateway_issuer', 'ontos_runtime'),
    `${canonical}?user=ontos_admin`,
    `${canonical}#fragment`,
    canonical.replace('postgres:', 'https:'),
  ]) {
    expect(setupAddressMatches(new URL(address), expected)).toBe(false);
  }
});
it('requires the actual restricted native session role and owned database', () => {
  const row = {
    bypass: false,
    createDb: false,
    createRole: false,
    currentUser: expected.user,
    database,
    sessionUser: expected.user,
    superuser: false,
  };
  expect(restrictedNativeIdentityMatches(row, database, expected.user)).toBe(true);
  for (const delta of [
    { database: 'ontos' },
    { currentUser: 'ontos_runtime' },
    { sessionUser: 'ontos_admin' },
    { superuser: true },
    { bypass: true },
    { createRole: true },
    { createDb: true },
  ]) {
    expect(restrictedNativeIdentityMatches({ ...row, ...delta }, database, expected.user)).toBe(false);
  }
});
