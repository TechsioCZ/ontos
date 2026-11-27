import { expect, it } from 'effect-rstest';
import { projectOntosModuleOperationContracts, registeredWorkloadCallReceiverIssue } from '@app/core-runtime';
import { partyRegistryRegisteredWorkloadCalls } from '../../src/registered-workload-calls.ts';
import { partyRegistryRuntimeManifest } from '../../vertical.runtime-declaration.ts';

const privacySetRead = 'privacy.core.api.source-processing-eligibility-set';

/** The one requirement and the one native-read rule the gateway admits a Party set read's Privacy call through. */
const privacySetHop = (entrypointKey: string) => {
  const requirements = (partyRegistryRuntimeManifest.requirements?.operations ?? []).filter(
    (requirement) => requirement.entrypointKey === entrypointKey && requirement.provider.entrypointKey === privacySetRead,
  );
  const rules = partyRegistryRegisteredWorkloadCalls.filter(
    (rule) =>
      rule.audience === 'privacy' &&
      rule.entrypointKey === privacySetRead &&
      rule.sourceWorkloadKey === 'party.registry.source-read' &&
      rule.jobKey === 'integration.symmy.execute-symmy-job' &&
      !('allowRecoverySource' in rule && rule.allowRecoverySource),
  );
  return { requirements, rules };
};

it('asks Privacy once per phase from the admission set and the profile export, through one declared requirement each', () => {
  for (const entrypointKey of ['party.registry.api.source-admission-set', 'party.registry.api.source-profile-export']) {
    const { requirements, rules } = privacySetHop(entrypointKey);
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.key).toBe(
      `party.registry.requirement.${entrypointKey.slice('party.registry.'.length)}-source-privacy-set`,
    );
    expect(rules).toHaveLength(1);
  }
});

it('publishes the admission set for the customer-profile source page with its workload carrier', () => {
  const operationContracts = projectOntosModuleOperationContracts(partyRegistryRuntimeManifest);
  const issue = registeredWorkloadCallReceiverIssue(
    {
      audience: 'party-registry',
      declarationKey: 'party.registry.source-admission-set.read',
      entrypointKey: 'party.registry.api.source-admission-set',
      legalEntityScope: 'required',
      schemaVersion: '1',
      workloadKey: 'party.registry.source-read',
    },
    {
      deployment: { appId: 'party-registry', buildMarker: 'test' },
      manifest: {
        publicSurface: {
          actions: partyRegistryRuntimeManifest.publicSurface.actions.map(({ descriptor }) => descriptor),
          operationContracts,
        },
      },
    },
  );
  expect(issue).toBeUndefined();
});
