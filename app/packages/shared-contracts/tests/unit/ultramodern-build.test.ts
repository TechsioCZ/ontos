import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withUltramodernBuildIdentity } from '@app/shared-contracts/ultramodern-build';

test('injected build identity updates all surfaces without mutating generated metadata', () => {
  const deliveryUnit = {
    appId: 'build-identity-test',
    build: 'generated-build',
    buildMarker: 'generated-build',
    sourceRevision: 'workspace',
  } as const;
  const artifact = {
    deliveryUnit,
    kind: 'ultramodern-build-artifact',
    schemaVersion: 1,
    surfaces: {
      api: { ...deliveryUnit, surface: 'api' },
      ui: { ...deliveryUnit, surface: 'ui' },
    },
  } as const;
  const result = withUltramodernBuildIdentity(artifact, 'injected-build', 'source-revision');
  const expectedIdentity = {
    ...deliveryUnit,
    build: 'injected-build',
    buildMarker: 'injected-build',
    sourceRevision: 'source-revision',
  };
  assert.deepEqual(result, {
    ...artifact,
    deliveryUnit: expectedIdentity,
    surfaces: {
      api: { ...expectedIdentity, surface: 'api' },
      ui: { ...expectedIdentity, surface: 'ui' },
    },
  });
  assert.equal(artifact.deliveryUnit.build, 'generated-build');
  assert.equal(artifact.surfaces.api.sourceRevision, 'workspace');
  assert.equal(artifact.surfaces.ui.buildMarker, 'generated-build');
});
