import { expect, it } from '@app/effect-rstest';
import {
  computeActionRequestHash,
  computeCanonicalValueHash,
} from '../../src/actions/repository.ts';
import type { ResolvedReadPermissionTarget } from '../../src/index.ts';
import * as publicSurface from '../../src/index.ts';

const principal = {
  authMethod: 'session',
  principalId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000001',
} as const;

it('computes deterministic hashes independent of object key ordering', () => {
  const left = computeActionRequestHash({
    actionKey: 'shell.test.hash',
    normalizedPayload: {
      nested: { alpha: 1, beta: 2 },
      values: ['first', 'second'],
    },
    owningModuleKey: 'shell.core',
    principal,
    schemaVersion: '1',
    target: {
      targetModuleKey: 'shell.core',
      targetResourceId: 'primary',
      targetResourceType: 'test-state',
    },
  });
  const right = computeActionRequestHash({
    actionKey: 'shell.test.hash',
    normalizedPayload: {
      nested: { alpha: 1, beta: 2 },
      values: ['first', 'second'],
    },
    owningModuleKey: 'shell.core',
    principal,
    schemaVersion: '1',
    target: {
      targetModuleKey: 'shell.core',
      targetResourceId: 'primary',
      targetResourceType: 'test-state',
    },
  });

  expect(left).toBe(right);
  expect(left).not.toBe(
    computeCanonicalValueHash({
      nested: { alpha: 1, beta: 3 },
      values: ['first', 'second'],
    }),
  );
});

it('rejects cyclic values instead of producing an unstable request hash', () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);

  expect(() =>
    computeActionRequestHash({
      actionKey: 'shell.test.hash',
      normalizedPayload: cyclic,
      owningModuleKey: 'shell.core',
      principal,
      schemaVersion: '1',
      target: {},
    }),
  ).toThrow();
});

it('canonical hashing distinguishes literal objects from internal value types', () => {
  expect(computeCanonicalValueHash()).not.toBe(computeCanonicalValueHash({ $undefined: true }));
  expect(computeCanonicalValueHash(Number.NaN)).not.toBe(
    computeCanonicalValueHash({ $number: 'NaN' }),
  );
  expect(computeCanonicalValueHash(-0)).not.toBe(computeCanonicalValueHash(0));
});

it('publishes only the narrow server Action surface', () => {
  expect('ActionRuntime' in publicSurface).toBe(true);
  expect('defineAction' in publicSurface).toBe(true);
  expect('defineGlobalPolicy' in publicSurface).toBe(true);
  expect('defineMicroverticalPolicy' in publicSurface).toBe(true);
  expect('defineActionResourcePermission' in publicSurface).toBe(true);
  expect('LEGAL_ENTITY_PERMISSION_KEYS' in publicSurface).toBe(true);
  expect('TENANT_PERMISSION_KEYS' in publicSurface).toBe(true);
  expect('denyPolicy' in publicSurface).toBe(true);
  expect('ActionPolicyDenied' in publicSurface).toBe(true);
  expect('ActionPolicyEvaluationError' in publicSurface).toBe(true);
  expect('ActionPermissionDenied' in publicSurface).toBe(true);
  expect('ActionPermissionCheckError' in publicSurface).toBe(true);
  expect('resolveActionCommit' in publicSurface).toBe(true);
  expect('ActionRepository' in publicSurface).toBe(false);
  expect('ActionRepositoryLive' in publicSurface).toBe(false);
  expect('createActionCollector' in publicSurface).toBe(false);
  expect('makeActionRepository' in publicSurface).toBe(false);
  expect('finalizePolicyDenial' in publicSurface).toBe(false);
  expect('isActionPolicy' in publicSurface).toBe(false);
  expect('ActionPermission' in publicSurface).toBe(false);
  expect('ActionPermissionLive' in publicSurface).toBe(false);
  expect('SpiceDbConfig' in publicSurface).toBe(false);
  expect('createPermissionCheckClient' in publicSurface).toBe(false);
  expect('makeActionPermissionService' in publicSurface).toBe(false);
  expect('Pool' in publicSurface).toBe(false);
});

it('publishes the sanitized PostgreSQL classifier on the server surface', () => {
  expect('findPostgresFailure' in publicSurface).toBe(true);
});

it('publishes the typed governed Read alternative-target composition', () => {
  const target = {
    kind: 'any_of',
    targets: [
      {
        kind: 'resource',
        resource: {
          moduleId: 'party.registry',
          resourceId: 'counterparty-1',
          resourceType: 'counterparty',
        },
      },
      { kind: 'tenant', permission: 'manage_party_identity' },
    ],
  } as const satisfies ResolvedReadPermissionTarget;

  expect(target.kind).toBe('any_of');
  expect(target.targets[0].kind).toBe('resource');
});
