import { expect, it } from 'effect-rstest';

import { AUTH_TABLE_INVENTORY } from '../../api/auth/db/schema.ts';
import { ownedAuthRuntimePolicy } from '../support/api-key-gateway-auth-runtime.ts';

const database = `ontos_test_party_gateway_${'a'.repeat(32)}`;
const revision = 'b'.repeat(64);
const route = (name: string, user: string) => ({ database: name, host: '127.0.0.1', port: 15_432, user });
const source = () => ({ admin: route('source', 'administrator'), runtime: route('source', 'runtime') });
const owned = () => ({ admin: route(database, 'administrator'), runtime: route(database, 'runtime') });
const identity = (role: string) => ({
  address: '192.0.2.20',
  bypass_rls: false,
  database,
  database_oid: 42,
  owner: 'administrator',
  port: 5432,
  role,
  session_role: role,
  superuser: false,
});
type ObjectFact = Parameters<typeof ownedAuthRuntimePolicy.fixedGrantPlan>[0][number];
const inventory = (): ObjectFact[] => AUTH_TABLE_INVENTORY.map((name) => ({ kind: 'r', name, owner: 'administrator' }));

it('permits the pure policy for captured loopback client routes and matching forwarded internal server identities', () => {
  expect(ownedAuthRuntimePolicy.routePairIsOwned(owned(), source())).toBe(true);
  expect(ownedAuthRuntimePolicy.identityPairIsOwned(owned(), identity('administrator'), identity('runtime'))).toBe(
    true,
  );
  expect(ownedAuthRuntimePolicy.authorityIsCurrent(false, { phase: 'active', revision }, revision)).toBe(true);
  expect(ownedAuthRuntimePolicy.effectivePrivilegesAreSafe(true)).toBe(true);
});

for (const deployment of ['stage', 'production']) {
  it(`refuses ${deployment} in the pure route policy`, () => {
    expect(ownedAuthRuntimePolicy.routePairIsOwned(owned(), source(), deployment)).toBe(false);
  });
}
for (const side of ['admin', 'runtime'] as const) {
  it(`refuses ${side} client routes that do not match the captured trusted source host or port`, () => {
    const changedHost = owned();
    changedHost[side].host = 'localhost';
    expect(ownedAuthRuntimePolicy.routePairIsOwned(changedHost, source())).toBe(false);
    const changedPort = owned();
    changedPort[side].port = 15_433;
    expect(ownedAuthRuntimePolicy.routePairIsOwned(changedPort, source())).toBe(false);
    const remote = owned();
    remote[side].host = '192.0.2.20';
    const remoteSource = source();
    remoteSource[side].host = remote[side].host;
    expect(ownedAuthRuntimePolicy.routePairIsOwned(remote, remoteSource)).toBe(false);
  });
}
it('refuses source databases, mismatched target identities, forged prefixes and non-distinct runtime roles', () => {
  const sourceTarget = { admin: route('source', 'administrator'), runtime: route('source', 'runtime') };
  expect(ownedAuthRuntimePolicy.routePairIsOwned(sourceTarget, source())).toBe(false);
  const sourceWithOwnedName = source();
  sourceWithOwnedName.runtime.database = database;
  expect(ownedAuthRuntimePolicy.routePairIsOwned(owned(), sourceWithOwnedName)).toBe(false);
  const foreign = owned();
  foreign.runtime.database = `${database}f`;
  expect(ownedAuthRuntimePolicy.routePairIsOwned(foreign, source())).toBe(false);
  const forged = {
    admin: route('ontos_test_party_gateway_arbitrary', 'administrator'),
    runtime: route('ontos_test_party_gateway_arbitrary', 'runtime'),
  };
  expect(ownedAuthRuntimePolicy.routePairIsOwned(forged, source())).toBe(false);
  const sameRole = owned();
  sameRole.runtime.user = sameRole.admin.user;
  expect(ownedAuthRuntimePolicy.routePairIsOwned(sameRole, source())).toBe(false);
  const privilegedRole = owned();
  privilegedRole.runtime.user = 'postgres';
  expect(ownedAuthRuntimePolicy.routePairIsOwned(privilegedRole, source())).toBe(false);
});
for (const [name, patch] of [
  ['foreign target database', { database: 'source' }],
  ['foreign target OID', { database_oid: 99 }],
  ['foreign owner', { owner: 'other' }],
  ['wrong current role', { role: 'administrator' }],
  ['wrong session role', { session_role: 'administrator' }],
  ['superuser', { superuser: true }],
  ['BYPASSRLS', { bypass_rls: true }],
  ['mismatched actual endpoint', { address: '192.0.2.21' }],
  ['mismatched actual port', { port: 5433 }],
  ['empty actual endpoint', { address: '' }],
  ['blank actual endpoint', { address: ' ' }],
  ['zero actual port', { port: 0 }],
  ['negative actual port', { port: -1 }],
  ['overflow actual port', { port: 65_536 }],
  ['fractional actual port', { port: 5432.5 }],
  ['nonfinite actual port', { port: Number.NaN }],
] as const) {
  it(`refuses ${name} in the actual identity facts policy`, () => {
    expect(
      ownedAuthRuntimePolicy.identityPairIsOwned(owned(), identity('administrator'), {
        ...identity('runtime'),
        ...patch,
      }),
    ).toBe(false);
  });
}
it('refuses missing decoded identity facts and independently checks the administrative row', () => {
  expect(ownedAuthRuntimePolicy.identityPairIsOwned(owned(), identity('administrator'), {})).toBe(false);
  expect(ownedAuthRuntimePolicy.identityPairIsOwned(owned(), {}, identity('runtime'))).toBe(false);
  for (const patch of [
    { database: 'source' },
    { database_oid: 99 },
    { owner: 'other' },
    { role: 'runtime' },
    { session_role: 'runtime' },
    { address: '' },
    { port: 0 },
  ]) {
    expect(
      ownedAuthRuntimePolicy.identityPairIsOwned(
        owned(),
        { ...identity('administrator'), ...patch },
        identity('runtime'),
      ),
    ).toBe(false);
  }
  // Administrative privilege does not become runtime privilege; the two role checks remain separate.
  expect(
    ownedAuthRuntimePolicy.identityPairIsOwned(
      owned(),
      { ...identity('administrator'), bypass_rls: true, superuser: true },
      identity('runtime'),
    ),
  ).toBe(true);
});
it('refuses foreign revision, nonactive authority and ended scope using only observed policy facts', () => {
  expect(ownedAuthRuntimePolicy.authorityIsCurrent(true, { phase: 'active', revision }, revision)).toBe(false);
  expect(
    ownedAuthRuntimePolicy.authorityIsCurrent(false, { phase: 'active', revision: 'c'.repeat(64) }, revision),
  ).toBe(false);
  for (const phase of ['draining', 'sealed', 'migrated']) {
    expect(ownedAuthRuntimePolicy.authorityIsCurrent(false, { phase, revision }, revision)).toBe(false);
  }
});
it('returns only the frozen current six-table ACL plan without sequence, role or broad schema privileges', () => {
  const plan = ownedAuthRuntimePolicy.fixedGrantPlan(inventory(), true, 'administrator');
  expect(plan).toEqual({
    schema: 'auth',
    schemaPrivileges: ['USAGE'],
    tablePrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    tables: [...AUTH_TABLE_INVENTORY],
  });
  expect(Object.isFrozen(ownedAuthRuntimePolicy)).toBe(true);
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan?.tables)).toBe(true);
  expect(Object.isFrozen(plan?.tablePrivileges)).toBe(true);
  expect(Object.isFrozen(plan?.schemaPrivileges)).toBe(true);
});
it('refuses missing, duplicate, extra, nonordinary, sequence and foreign-owned Auth objects or schema', () => {
  expect(ownedAuthRuntimePolicy.fixedGrantPlan(inventory().slice(1), true, 'administrator')).toBeUndefined();
  expect(
    ownedAuthRuntimePolicy.fixedGrantPlan(
      [...inventory(), { kind: 'r', name: 'extra', owner: 'administrator' }],
      true,
      'administrator',
    ),
  ).toBeUndefined();
  const duplicate = inventory();
  duplicate[0] = { kind: 'r', name: 'session', owner: 'administrator' };
  expect(ownedAuthRuntimePolicy.fixedGrantPlan(duplicate, true, 'administrator')).toBeUndefined();
  for (const kind of ['S', 'p', 'v', 'm', 'f']) {
    const changed = inventory().map((object) => ({ ...object, kind }));
    expect(ownedAuthRuntimePolicy.fixedGrantPlan(changed, true, 'administrator')).toBeUndefined();
  }
  expect(
    ownedAuthRuntimePolicy.fixedGrantPlan(
      inventory().map((object) => ({ ...object, owner: 'other' })),
      true,
      'administrator',
    ),
  ).toBeUndefined();
  expect(ownedAuthRuntimePolicy.fixedGrantPlan(inventory(), false, 'administrator')).toBeUndefined();
});
it('keeps the fixed plan independent of mutable input facts and rejects unsafe effective ACL evidence', () => {
  const facts = inventory();
  const plan = ownedAuthRuntimePolicy.fixedGrantPlan(facts, true, 'administrator');
  facts[0] = { kind: 'S', name: 'changed', owner: 'other' };
  expect(plan?.tables).toEqual([...AUTH_TABLE_INVENTORY]);
  expect(ownedAuthRuntimePolicy.fixedGrantPlan(facts, true, 'administrator')).toBeUndefined();
  expect(ownedAuthRuntimePolicy.effectivePrivilegesAreSafe(false)).toBe(false);
});
