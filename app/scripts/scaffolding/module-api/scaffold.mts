import { createCodesmithGenerator } from '../generator-adapter.mts';
import { planGovernedContributionScaffold } from '../governed-contribution/scaffold.mts';
import { planCoreReadScaffold } from './core-read.mts';
import type { CoreReadScaffoldConfig, GovernedContributionScaffoldConfig } from '../shared.mts';

export default createCodesmithGenerator(
  (workspaceRoot: string, config: CoreReadScaffoldConfig | GovernedContributionScaffoldConfig) =>
    'core' in config
      ? planCoreReadScaffold(workspaceRoot, config)
      : planGovernedContributionScaffold(workspaceRoot, 'module-api', config),
);
