import type { OntosModuleDeploymentContractSchema } from '@app/core-runtime';
import { compositionFixtureContentDigest } from '@app/core-runtime/testing/module-contract';

type ModuleContract = typeof OntosModuleDeploymentContractSchema.Type;
type ShellContributions = ModuleContract['manifest']['publicSurface']['shellContributions'];

/** The Module Federation remote Symmy's deployment publishes (`verticalSymmyIntegration` in the topology). */
const symmyFederationRemote = 'verticalSymmyIntegration';

/**
 * The public components Symmy's built contract publishes: one for each Shell public component contribution, exposed
 * by Symmy's own remote, exactly as the module contract generator derives them.
 */
export const symmyContractComponents = (
  shellContributions: ShellContributions,
): ModuleContract['manifest']['publicSurface']['components'] =>
  shellContributions.publicComponents.map(({ componentKey, expose }) => ({
    expose,
    key: componentKey,
    mfBoundaryId: symmyFederationRemote,
  }));

/**
 * What an Application Composition pins for Symmy's browser remote: every Shell contribution its contract offers and
 * the Federation manifest that exposes its components.
 */
export const symmyBrowserComposition = (contract: ModuleContract) => {
  const { components, shellContributions } = contract.manifest.publicSurface;
  const { appId, buildMarker } = contract.deployment;
  return {
    allowedContributions: Object.values(shellContributions).flatMap((items) =>
      items.map(({ contributionKey }) => contributionKey),
    ),
    federation: {
      execution: 'browser' as const,
      exposes: components.map(({ expose }) => expose),
      manifest: {
        sha256: compositionFixtureContentDigest(`${buildMarker}-manifest`),
        url: `https://${appId}.example.test/releases/${buildMarker}/mf-manifest.json`,
      },
      remoteName: symmyFederationRemote,
    },
  };
};
