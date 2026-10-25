import { Option } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  BEARER_ASSERTION_ROLE_SETTINGS,
  DATABASE_IDENTITIES,
  DEDICATED_IDENTITY_MODULE_KEYS,
  gatewayScopeGrantRoleForAudience,
} from '../../src/db/database-identities.ts';

const MODULE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

const expectUnique = (values: readonly string[]) => {
  expect(new Set(values).size).toBe(values.length);
};

it('declares unique roles, URL keys, and Hyperdrive bindings', () => {
  expectUnique(DATABASE_IDENTITIES.map((identity) => identity.id));
  expectUnique(DATABASE_IDENTITIES.map((identity) => identity.role));
  expectUnique(DATABASE_IDENTITIES.map((identity) => identity.urlKey));
  const hyperdrives = DATABASE_IDENTITIES.flatMap((identity) =>
    identity.cloudflareHyperdrive === null ? [] : [identity.cloudflareHyperdrive],
  );
  expectUnique(hyperdrives.map((hyperdrive) => hyperdrive.binding));
  expectUnique(hyperdrives.map((hyperdrive) => hyperdrive.idVariable));
  expect(DATABASE_IDENTITIES.map((identity) => identity.role)).toEqual([
    'ontos_runtime',
    'shell_gateway_issuer',
    'party_registry_runtime',
    'party_registry_worker',
  ]);
});

it('lets exactly one identity register gateway scope grants', () => {
  const registrars = DATABASE_IDENTITIES.filter((identity) => identity.registersGatewayScopeGrants);
  expect(registrars.map((identity) => identity.role)).toEqual(['shell_gateway_issuer']);
});

it('maps each gateway audience to exactly one gateway-grant role', () => {
  const audiences = DATABASE_IDENTITIES.flatMap((identity) => identity.gatewayScopeAudiences);
  expectUnique(audiences);
  for (const identity of DATABASE_IDENTITIES) {
    if (identity.gatewayScopeAudiences.length > 0) {
      expect(identity.scopeAuthority).toBe('gateway_grant');
    }
  }
  for (const audience of audiences) {
    const owners = DATABASE_IDENTITIES.filter((identity) => identity.gatewayScopeAudiences.includes(audience));
    expect(owners).toHaveLength(1);
  }
});

it('resolves gateway scope roles only for enrolled audiences', () => {
  expect(Option.getOrNull(gatewayScopeGrantRoleForAudience('party-registry'))).toBe('party_registry_runtime');
  expect(Option.isNone(gatewayScopeGrantRoleForAudience('catalog'))).toBe(true);
  expect(Option.isNone(gatewayScopeGrantRoleForAudience('shell-super-app'))).toBe(true);
});

it('uses canonical owner module keys', () => {
  for (const identity of DATABASE_IDENTITIES) {
    if (identity.ownerModuleKey !== null) {
      expect(identity.ownerModuleKey).toMatch(MODULE_KEY_PATTERN);
    }
  }
  expect(DEDICATED_IDENTITY_MODULE_KEYS).toEqual(['party.registry']);
  expect(BEARER_ASSERTION_ROLE_SETTINGS).toEqual(['log_parameter_max_length=0', 'log_parameter_max_length_on_error=0']);
});
