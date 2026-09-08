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
