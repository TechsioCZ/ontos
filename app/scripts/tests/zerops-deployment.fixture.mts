import { readFileSync } from 'node:fs';

/** The checked-in setups of `app/zerops.yaml`, the one Zerops deployment file. */
export const readZeropsDeploymentYaml = (): string =>
  readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8');
