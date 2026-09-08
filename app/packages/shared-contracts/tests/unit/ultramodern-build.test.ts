import { expect, it } from 'effect-rstest';
import { withUltramodernBuildIdentity } from '@app/shared-contracts/ultramodern-build';

it('injected build identity updates all surfaces without mutating generated metadata', () => {
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
  expect(result).toEqual({
    ...artifact,
    deliveryUnit: expectedIdentity,
    surfaces: {
      api: { ...expectedIdentity, surface: 'api' },
      ui: { ...expectedIdentity, surface: 'ui' },
    },
  });
  expect(artifact.deliveryUnit.build).toBe('generated-build');
  expect(artifact.surfaces.api.sourceRevision).toBe('workspace');
  expect(artifact.surfaces.ui.buildMarker).toBe('generated-build');
});
