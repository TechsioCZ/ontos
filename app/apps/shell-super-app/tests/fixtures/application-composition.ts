import { ONTOS_SHELL_CONTRIBUTION_ABI } from '@app/core-runtime';
import type { ApplicationComposition } from '@app/core-runtime';
import { makePublishedApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';

import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

export {
  compositionFixtureContentDigest as contentDigest,
  sealApplicationCompositionFixture as sealComposition,
} from '@app/core-runtime/testing/module-contract';

const shellDeployment: ApplicationComposition['shell']['deployment'] = {
  appId: 'shell-super-app',
  buildMarker: ultramodernDeliveryUnit.buildMarker,
};
const shellRuntimeContractDocument = JSON.stringify({
  contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
  coreCapabilities: [],
  deployment: shellDeployment,
  schemaVersion: '2',
});

export const makeCompositionSnapshot = (
  contractInputs: readonly unknown[],
  validityMs = 60_000,
  publishedShellRuntime?: {
    readonly document: string;
    readonly receiverDeployment: ApplicationComposition['shell']['deployment'];
  },
) =>
  makePublishedApplicationCompositionSnapshotFixture({
    contractInputs,
    publishedShellRuntime: publishedShellRuntime ?? {
      document: shellRuntimeContractDocument,
      receiverDeployment: shellDeployment,
    },
    validityMs,
  });
