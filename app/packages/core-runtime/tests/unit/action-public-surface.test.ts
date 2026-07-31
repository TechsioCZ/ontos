import assert from 'node:assert/strict';
import test from 'node:test';
import * as publicSurface from '../../src/index.ts';
import {
  computeActionRequestHash,
  computeCanonicalValueHash,
} from '../../src/actions/repository.ts';

const principal = {
  authMethod: 'session',
  principalId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000001',
} as const;

test('computes deterministic hashes independent of object key ordering', () => {
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

  assert.equal(left, right);
  assert.notEqual(
    left,
    computeCanonicalValueHash({
      nested: { alpha: 1, beta: 3 },
      values: ['first', 'second'],
    }),
  );
});

test('rejects cyclic values instead of producing an unstable request hash', () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);

  assert.throws(() =>
    computeActionRequestHash({
      actionKey: 'shell.test.hash',
      normalizedPayload: cyclic,
      owningModuleKey: 'shell.core',
      principal,
      schemaVersion: '1',
      target: {},
    }),
  );
});

test('canonical hashing distinguishes literal objects from internal value types', () => {
  assert.notEqual(computeCanonicalValueHash(), computeCanonicalValueHash({ $undefined: true }));
  assert.notEqual(
    computeCanonicalValueHash(Number.NaN),
    computeCanonicalValueHash({ $number: 'NaN' }),
  );
  assert.notEqual(computeCanonicalValueHash(-0), computeCanonicalValueHash(0));
});

test('publishes only the narrow server Action surface', () => {
  assert.equal('ActionRuntime' in publicSurface, true);
  assert.equal('defineAction' in publicSurface, true);
  assert.equal('defineGlobalPolicy' in publicSurface, true);
  assert.equal('defineMicroverticalPolicy' in publicSurface, true);
  assert.equal('denyPolicy' in publicSurface, true);
  assert.equal('ActionPolicyDenied' in publicSurface, true);
  assert.equal('ActionPolicyEvaluationError' in publicSurface, true);
  assert.equal('ActionPermissionDenied' in publicSurface, true);
  assert.equal('ActionPermissionCheckError' in publicSurface, true);
  assert.equal('resolveActionCommit' in publicSurface, true);
  assert.equal('ActionRepository' in publicSurface, false);
  assert.equal('ActionRepositoryLive' in publicSurface, false);
  assert.equal('makeActionCollector' in publicSurface, false);
  assert.equal('makeActionRepository' in publicSurface, false);
  assert.equal('finalizePolicyDenial' in publicSurface, false);
  assert.equal('isActionPolicy' in publicSurface, false);
  assert.equal('ActionPermission' in publicSurface, false);
  assert.equal('ActionPermissionLive' in publicSurface, false);
  assert.equal('SpiceDbConfig' in publicSurface, false);
  assert.equal('createPermissionCheckClient' in publicSurface, false);
  assert.equal('makeActionPermissionService' in publicSurface, false);
  assert.equal('Pool' in publicSurface, false);
});
