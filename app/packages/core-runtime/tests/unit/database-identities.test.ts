import { Option } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  BEARER_ASSERTION_ROLE_SETTINGS,
  DatabaseIdentityEnrollmentError,
  defineDatabaseIdentityEnrollment,
  gatewayScopeGrantRoleForAudience,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '../../src/db/database-identities.ts';
import type { DatabaseOwnerIdentityDescriptor } from '../../src/db/database-identities.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const { dedicatedModuleKeys, identities } = FIXTURE_DATABASE_IDENTITY_ENROLLMENT;

const MODULE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

const expectUnique = (values: readonly string[]) => {
  expect(new Set(values).size).toBe(values.length);
};

it('declares unique roles, URL keys, and Hyperdrive bindings', () => {
  expectUnique(identities.map((identity) => identity.id));
  expectUnique(identities.map((identity) => identity.role));
  expectUnique(identities.map((identity) => identity.urlKey));
  const hyperdrives = identities.flatMap((identity) =>
    identity.cloudflareHyperdrive === null ? [] : [identity.cloudflareHyperdrive],
  );
  expectUnique(hyperdrives.map((hyperdrive) => hyperdrive.binding));
  expectUnique(hyperdrives.map((hyperdrive) => hyperdrive.idVariable));
  expect(identities.map((identity) => identity.role)).toEqual([
    'ontos_runtime',
    'shell_gateway_issuer',
    'party_registry_runtime',
    'party_registry_worker',
  ]);
});

it('lets exactly one identity register gateway scope grants', () => {
  const registrars = identities.filter((identity) => identity.registersGatewayScopeGrants);
  expect(registrars.map((identity) => identity.role)).toEqual(['shell_gateway_issuer']);
});

it('maps each gateway audience to exactly one gateway-grant role', () => {
  const audiences = identities.flatMap((identity) => identity.gatewayScopeAudiences);
  expectUnique(audiences);
  for (const identity of identities) {
    if (identity.gatewayScopeAudiences.length > 0) {
      expect(identity.scopeAuthority).toBe('gateway_grant');
    }
  }
  for (const audience of audiences) {
    const owners = identities.filter((identity) => identity.gatewayScopeAudiences.includes(audience));
    expect(owners).toHaveLength(1);
  }
});

it('resolves gateway scope roles only for enrolled audiences', () => {
  expect(
    Option.getOrNull(gatewayScopeGrantRoleForAudience(FIXTURE_DATABASE_IDENTITY_ENROLLMENT, 'party-registry')),
  ).toBe('party_registry_runtime');
  expect(Option.isNone(gatewayScopeGrantRoleForAudience(FIXTURE_DATABASE_IDENTITY_ENROLLMENT, 'catalog'))).toBe(true);
  expect(Option.isNone(gatewayScopeGrantRoleForAudience(FIXTURE_DATABASE_IDENTITY_ENROLLMENT, 'shell-super-app'))).toBe(
    true,
  );
});

it('uses canonical owner module keys', () => {
  for (const identity of identities) {
    if (identity.ownerModuleKey !== null) {
      expect(identity.ownerModuleKey).toMatch(MODULE_KEY_PATTERN);
    }
  }
  expect(dedicatedModuleKeys).toEqual(['party.registry']);
  expect(BEARER_ASSERTION_ROLE_SETTINGS).toEqual(['log_parameter_max_length=0', 'log_parameter_max_length_on_error=0']);
});

const genericOwner = (prefix: string): DatabaseOwnerIdentityDescriptor => ({
  moduleKey: `${prefix}.owner`,
  policyPrefix: prefix,
  request: {
    cloudflareHyperdrive: {
      binding: `${prefix.toUpperCase()}_HYPERDRIVE`,
      idVariable: `ULTRAMODERN_${prefix.toUpperCase()}_HYPERDRIVE_ID`,
    },
    gatewayScopeAudiences: [`${prefix}-api`, `${prefix}-reports`],
    handlesBearerAssertions: true,
    id: `${prefix}_request`,
    ownerModuleKey: `${prefix}.owner`,
    registersGatewayScopeGrants: false,
    role: `${prefix}_runtime`,
    scopeAuthority: 'gateway_grant',
    urlKey: `${prefix.toUpperCase()}_DATABASE_URL`,
  },
  schemas: [`${prefix}_private`],
  worker: {
    cloudflareHyperdrive: null,
    gatewayScopeAudiences: [],
    handlesBearerAssertions: false,
    id: `${prefix}_worker`,
    ownerModuleKey: `${prefix}.owner`,
    registersGatewayScopeGrants: false,
    role: `${prefix}_worker`,
    scopeAuthority: 'session_setting',
    urlKey: `${prefix.toUpperCase()}_WORKER_DATABASE_URL`,
  },
});

it('enrolls unrelated owners and derives their audience and trust-routine authority without a global registry', () => {
  const ledger = genericOwner('ledger');
  const warehouse = genericOwner('warehouse');
  const enrollment = defineDatabaseIdentityEnrollment([ledger, warehouse]);
  expect(enrollment.dedicatedModuleKeys).toEqual(['ledger.owner', 'warehouse.owner']);
  expect(enrollment.owners).toEqual([ledger, warehouse]);
  expect(enrollment.identities).toEqual([
    SHARED_RUNTIME_IDENTITY,
    SHELL_GATEWAY_ISSUER_IDENTITY,
    ledger.request,
    ledger.worker,
    warehouse.request,
    warehouse.worker,
  ]);
  for (const owner of [ledger, warehouse]) {
    for (const audience of owner.request.gatewayScopeAudiences) {
      expect(Option.getOrNull(gatewayScopeGrantRoleForAudience(enrollment, audience))).toBe(owner.request.role);
    }
  }
  expect(Option.isNone(gatewayScopeGrantRoleForAudience(enrollment, 'party-registry'))).toBe(true);
  expect(Option.isNone(gatewayScopeGrantRoleForAudience(enrollment, 'unknown-api'))).toBe(true);
  expect(
    enrollment.trustRoutines.find(({ signature }) => signature.startsWith('trust.register_gateway_scope_grant('))
      ?.executableBy,
  ).toEqual(['shell_gateway_issuer']);
  for (const routine of enrollment.trustRoutines) {
    expect(routine.executableBy).not.toContain(ledger.worker.role);
    expect(routine.executableBy).not.toContain(warehouse.worker.role);
    if (routine.signature === 'trust.establish_gateway_scope(text)') {
      expect(routine.executableBy).toEqual([ledger.request.role, warehouse.request.role]);
      expect(routine.securityDefiner).toBe(true);
    }
  }
  const platformOnly = defineDatabaseIdentityEnrollment([]);
  expect(platformOnly.identities).toEqual([SHARED_RUNTIME_IDENTITY, SHELL_GATEWAY_ISSUER_IDENTITY]);
  expect(platformOnly.owners).toEqual([]);
  expect(platformOnly.dedicatedModuleKeys).toEqual([]);
  expect(Option.isNone(gatewayScopeGrantRoleForAudience(platformOnly, 'ledger-api'))).toBe(true);
  expect(
    platformOnly.trustRoutines.find(({ signature }) => signature === 'trust.establish_gateway_scope(text)')
      ?.executableBy,
  ).toEqual([]);
});

it('copies and deeply freezes the enrollment so later caller mutations cannot change authority', () => {
  const base = genericOwner('ledger');
  const request = {
    ...base.request,
    cloudflareHyperdrive: { binding: 'LEDGER_HYPERDRIVE', idVariable: 'ULTRAMODERN_LEDGER_HYPERDRIVE_ID' },
    gatewayScopeAudiences: ['ledger-api'],
  };
  const worker = { ...base.worker, gatewayScopeAudiences: Array.of<string>() };
  const descriptor = { ...base, request, schemas: ['ledger_private'], worker };
  const owners = [descriptor];
  const enrollment = defineDatabaseIdentityEnrollment(owners);
  const snapshot = {
    dedicatedModuleKeys: [...enrollment.dedicatedModuleKeys],
    identities: [...enrollment.identities],
    owners: [...enrollment.owners],
    trustRoutines: [...enrollment.trustRoutines],
  };
  owners.length = 0;
  descriptor.moduleKey = 'changed.owner';
  descriptor.schemas.push('changed_private');
  request.role = 'changed_runtime';
  request.gatewayScopeAudiences.push('changed-api');
  request.cloudflareHyperdrive.binding = 'CHANGED_HYPERDRIVE';
  worker.role = 'changed_worker';
  expect(enrollment).toMatchObject(snapshot);
  expect(Object.isFrozen(enrollment)).toBe(true);
  expect(Object.isFrozen(enrollment.identities)).toBe(true);
  expect(Object.isFrozen(enrollment.owners)).toBe(true);
  expect(Object.isFrozen(enrollment.dedicatedModuleKeys)).toBe(true);
  expect(Object.isFrozen(enrollment.trustRoutines)).toBe(true);
  expect(Option.getOrNull(gatewayScopeGrantRoleForAudience(enrollment, 'ledger-api'))).toBe('ledger_runtime');
  expect(Option.isNone(gatewayScopeGrantRoleForAudience(enrollment, 'changed-api'))).toBe(true);
  expect(Reflect.set(enrollment, 'identities', [])).toBe(false);
  expect(Reflect.set(enrollment.identities, 'length', 0)).toBe(false);
  expect(Reflect.set(enrollment.owners, 'length', 0)).toBe(false);
  expect(Reflect.set(enrollment.dedicatedModuleKeys, 'length', 0)).toBe(false);
  expect(Reflect.set(enrollment.trustRoutines, 'length', 0)).toBe(false);
  for (const owner of enrollment.owners) {
    expect(Object.isFrozen(owner)).toBe(true);
    expect(Object.isFrozen(owner.schemas)).toBe(true);
    expect(owner).not.toBe(descriptor);
    expect(owner.request).not.toBe(request);
    expect(owner.request.gatewayScopeAudiences).not.toBe(request.gatewayScopeAudiences);
    expect(owner.request.cloudflareHyperdrive).not.toBe(request.cloudflareHyperdrive);
    expect(owner.worker).not.toBe(worker);
    expect(owner.schemas).not.toBe(descriptor.schemas);
  }
  for (const identity of enrollment.identities) {
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.gatewayScopeAudiences)).toBe(true);
    if (identity.cloudflareHyperdrive !== null) {
      expect(Object.isFrozen(identity.cloudflareHyperdrive)).toBe(true);
    }
  }
  for (const routine of enrollment.trustRoutines) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(Object.isFrozen(routine.executableBy)).toBe(true);
  }
});

const first = genericOwner('ledger');
const second = genericOwner('warehouse');
const requestCollision = (
  overrides: Partial<DatabaseOwnerIdentityDescriptor['request']>,
): DatabaseOwnerIdentityDescriptor => ({ ...second, request: { ...second.request, ...overrides } });

for (const [label, collision] of [
  [
    'module keys',
    {
      ...second,
      moduleKey: first.moduleKey,
      request: { ...second.request, ownerModuleKey: first.moduleKey },
      worker: { ...second.worker, ownerModuleKey: first.moduleKey },
    },
  ],
  ['policy prefixes', { ...second, policyPrefix: first.policyPrefix }],
  ['schema ownership', { ...second, schemas: first.schemas }],
  ['identity ids', requestCollision({ id: first.request.id })],
  ['roles', requestCollision({ role: first.worker.role })],
  ['URL keys', requestCollision({ urlKey: first.request.urlKey })],
  ['gateway audiences', requestCollision({ gatewayScopeAudiences: first.request.gatewayScopeAudiences })],
  [
    'Hyperdrive bindings',
    requestCollision({ cloudflareHyperdrive: { binding: 'LEDGER_HYPERDRIVE', idVariable: 'WAREHOUSE_HYPERDRIVE_ID' } }),
  ],
  [
    'Hyperdrive variables',
    requestCollision({
      cloudflareHyperdrive: { binding: 'WAREHOUSE_HYPERDRIVE', idVariable: 'ULTRAMODERN_LEDGER_HYPERDRIVE_ID' },
    }),
  ],
] as const) {
  it(`rejects duplicate ${label} across owners instead of choosing an ambiguous authority`, () => {
    expect(() => defineDatabaseIdentityEnrollment([first, collision])).toThrow(DatabaseIdentityEnrollmentError);
  });
}

for (const [label, descriptor] of [
  ['platform identity id', { ...first, request: { ...first.request, id: SHARED_RUNTIME_IDENTITY.id } }],
  ['platform role', { ...first, worker: { ...first.worker, role: SHELL_GATEWAY_ISSUER_IDENTITY.role } }],
  ['platform URL key', { ...first, request: { ...first.request, urlKey: SHARED_RUNTIME_IDENTITY.urlKey } }],
  [
    'platform Hyperdrive binding',
    {
      ...first,
      request: {
        ...first.request,
        cloudflareHyperdrive: { binding: 'HYPERDRIVE', idVariable: 'LEDGER_HYPERDRIVE_ID' },
      },
    },
  ],
  [
    'platform Hyperdrive variable',
    {
      ...first,
      request: {
        ...first.request,
        cloudflareHyperdrive: { binding: 'LEDGER_HYPERDRIVE', idVariable: 'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID' },
      },
    },
  ],
  [
    'repeated audience within one identity',
    { ...first, request: { ...first.request, gatewayScopeAudiences: ['ledger-api', 'ledger-api'] } },
  ],
  ['repeated schema within one owner', { ...first, schemas: ['ledger_private', 'ledger_private'] }],
  ['request/worker identity id', { ...first, worker: { ...first.worker, id: first.request.id } }],
  ['request/worker role', { ...first, worker: { ...first.worker, role: first.request.role } }],
  ['request/worker URL key', { ...first, worker: { ...first.worker, urlKey: first.request.urlKey } }],
] as const) {
  it(`rejects a ${label} collision within one enrollment`, () => {
    expect(() => defineDatabaseIdentityEnrollment([descriptor])).toThrow(DatabaseIdentityEnrollmentError);
  });
}

const authorityMismatches: readonly (readonly [string, DatabaseOwnerIdentityDescriptor])[] = [
  ['request owner', { ...first, request: { ...first.request, ownerModuleKey: second.moduleKey } }],
  ['worker owner', { ...first, worker: { ...first.worker, ownerModuleKey: null } }],
  ['request session authority', { ...first, request: { ...first.request, scopeAuthority: 'session_setting' } }],
  ['request missing bearer authority', { ...first, request: { ...first.request, handlesBearerAssertions: false } }],
  ['request registrar authority', { ...first, request: { ...first.request, registersGatewayScopeGrants: true } }],
  ['request without an audience', { ...first, request: { ...first.request, gatewayScopeAudiences: [] } }],
  ['worker gateway authority', { ...first, worker: { ...first.worker, scopeAuthority: 'gateway_grant' } }],
  ['worker without scope authority', { ...first, worker: { ...first.worker, scopeAuthority: 'none' } }],
  ['worker bearer authority', { ...first, worker: { ...first.worker, handlesBearerAssertions: true } }],
  ['worker registrar authority', { ...first, worker: { ...first.worker, registersGatewayScopeGrants: true } }],
  ['worker with an audience', { ...first, worker: { ...first.worker, gatewayScopeAudiences: ['ledger-worker'] } }],
  [
    'worker Hyperdrive binding',
    { ...first, worker: { ...first.worker, cloudflareHyperdrive: first.request.cloudflareHyperdrive } },
  ],
  ['owner without a schema', { ...first, schemas: [] }],
];
for (const [label, descriptor] of authorityMismatches) {
  it(`rejects inconsistent ${label} rather than increasing authority`, () => {
    expect(() => defineDatabaseIdentityEnrollment([descriptor])).toThrow(DatabaseIdentityEnrollmentError);
  });
}

for (const schema of ['core', 'trust', 'public', 'drizzle', 'pg_catalog', 'information_schema']) {
  it(`does not let an owner claim reserved schema ${schema}`, () => {
    expect(() => defineDatabaseIdentityEnrollment([{ ...first, schemas: [schema] }])).toThrow(
      DatabaseIdentityEnrollmentError,
    );
  });
}

for (const [label, descriptor] of [
  ['module key', { ...first, moduleKey: 'invalid module' }],
  ['policy prefix', { ...first, policyPrefix: 'unsafe-prefix' }],
  ['schema', { ...first, schemas: ['unsafe-schema'] }],
  ['identity id', { ...first, request: { ...first.request, id: 'Unsafe-Id' } }],
  ['role', { ...first, request: { ...first.request, role: 'unsafe;role' } }],
  ['overlong role', { ...first, worker: { ...first.worker, role: 'x'.repeat(64) } }],
  ['URL key', { ...first, request: { ...first.request, urlKey: 'lowercase' } }],
  ['audience', { ...first, request: { ...first.request, gatewayScopeAudiences: ['unsafe_audience'] } }],
  [
    'Hyperdrive binding',
    {
      ...first,
      request: { ...first.request, cloudflareHyperdrive: { binding: 'unsafe-binding', idVariable: 'LEDGER_ID' } },
    },
  ],
  [
    'Hyperdrive variable',
    {
      ...first,
      request: { ...first.request, cloudflareHyperdrive: { binding: 'LEDGER_HYPERDRIVE', idVariable: 'unsafe_id' } },
    },
  ],
] as const) {
  it(`rejects a malformed ${label} instead of retaining unchecked authority`, () => {
    expect(() => defineDatabaseIdentityEnrollment([descriptor])).toThrow(DatabaseIdentityEnrollmentError);
  });
}

for (const role of ['public', 'postgres', 'pg_reserved']) {
  it(`rejects reserved role ${role} for either owner identity`, () => {
    expect(() => defineDatabaseIdentityEnrollment([{ ...first, request: { ...first.request, role } }])).toThrow(
      DatabaseIdentityEnrollmentError,
    );
    expect(() => defineDatabaseIdentityEnrollment([{ ...first, worker: { ...first.worker, role } }])).toThrow(
      DatabaseIdentityEnrollmentError,
    );
  });
}

it('rejects undeclared owner facts instead of retaining unchecked configuration', () => {
  const undeclared = { ...first, additionalRegistrarRole: 'unapproved_runtime' };
  expect(() => defineDatabaseIdentityEnrollment([undeclared])).toThrow(DatabaseIdentityEnrollmentError);
  const undeclaredIdentity = { ...first, request: { ...first.request, additionalAuthority: 'registrar' } };
  expect(() => defineDatabaseIdentityEnrollment([undeclaredIdentity])).toThrow(DatabaseIdentityEnrollmentError);
});
