import type { MicroVerticalBuildMarkerSchema } from '@modern-js/bff-effect/microvertical-api';

interface BuildIdentity {
  readonly build: string;
  readonly buildMarker: string;
  readonly sourceRevision: string;
}

interface BuildArtifact {
  readonly deliveryUnit: BuildIdentity;
  readonly surfaces: {
    readonly api: BuildIdentity;
    readonly ui: BuildIdentity;
  };
}

/** Apply injected build identity consistently to every delivery-unit surface. */
export const withUltramodernBuildIdentity = <Artifact extends BuildArtifact>(
  artifact: Artifact,
  buildMarker: string,
  sourceRevision: string,
) => {
  const identity = { build: buildMarker, buildMarker, sourceRevision };
  return {
    ...artifact,
    deliveryUnit: { ...artifact.deliveryUnit, ...identity },
    surfaces: {
      api: { ...artifact.surfaces.api, ...identity },
      ui: { ...artifact.surfaces.ui, ...identity },
    },
  } as const;
};

type MicroVerticalBuildMarker = typeof MicroVerticalBuildMarkerSchema.Type;

/**
 * The readiness marker exactly as MicroVerticalBuildMarkerSchema declares it. A build surface also
 * carries its delivery-unit `kind` and `schemaVersion`, which the closed HTTP edge rejects.
 */
export const readinessMarker = ({
  appId,
  build,
  buildMarker,
  deployProfile,
  packageName,
  sourceRevision,
  surface,
  unitId,
  version,
}: MicroVerticalBuildMarker): MicroVerticalBuildMarker => ({
  appId,
  build,
  buildMarker,
  deployProfile,
  packageName,
  sourceRevision,
  surface,
  unitId,
  version,
});
