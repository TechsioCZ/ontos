import { readinessMarker, withUltramodernBuildIdentity } from '@app/shared-contracts/ultramodern-build';
import { MicroVerticalBuildMarkerSchema } from '@modern-js/bff-effect/microvertical-api';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

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

it('projects the api surface onto the readiness marker the closed HTTP edge encodes', () => {
  const surface = {
    appId: 'build-identity-test',
    build: 'generated-build',
    buildMarker: 'generated-build',
    deployProfile: 'cloudflare-ssr-mf-effect-v1',
    kind: 'microvertical-delivery-unit',
    packageName: '@app/build-identity-test',
    schemaVersion: 1,
    sourceRevision: 'workspace',
    surface: 'api',
    unitId: 'app/build-identity-test',
    version: '0.1.0',
  } as const;
  const marker = readinessMarker(surface);
  expect(Schema.encodeSync(MicroVerticalBuildMarkerSchema)(marker, { onExcessProperty: 'error' })).toEqual(marker);
  expect(() => Schema.encodeSync(MicroVerticalBuildMarkerSchema)(surface, { onExcessProperty: 'error' })).toThrow(
    /excess property/u,
  );
});
