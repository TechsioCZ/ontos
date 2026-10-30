import { readFileSync } from 'node:fs';

import { ZEROPS_DEPLOYMENT_FILES } from '../materialize-zerops-environment.mts';

/** The checked-in setups of every Zerops deployment file, in order, as one zerops.yaml text. */
export const readZeropsDeploymentYaml = (): string =>
  ZEROPS_DEPLOYMENT_FILES.map((file, index) => {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8');
    return index === 0 ? text : text.replace(/^(?:#.*\n)*zerops:\n/u, '');
  }).join('');
