import {
  ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY,
  ONTOS_SHELL_CONTRIBUTION_ABI,
} from '../packages/core-runtime/src/index.ts';
import type { OntosShellRuntimeContract } from '../packages/core-runtime/src/index.ts';

/**
 * The Shell reports the Core-defined contribution ABI and the Core capabilities it provides so the
 * Application Composition publisher observes them from the deployed Shell instead of assuming them.
 */
export const createShellRuntimeContract = (buildMarker: string): OntosShellRuntimeContract =>
  Object.freeze<OntosShellRuntimeContract>({
    contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
    deployment: { appId: 'shell-super-app', buildMarker },
    schemaVersion: '2',
  });
