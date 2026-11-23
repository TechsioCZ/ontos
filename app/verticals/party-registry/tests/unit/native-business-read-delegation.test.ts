import { expect, it } from 'effect-rstest';
import { organizationBusinessNameExportRead } from '../../src/api/organization-business-name-export.read.ts';
import { partyRegistryRegisteredWorkloadCalls } from '../../src/registered-workload-calls.ts';
import { partyRegistryRuntimeManifest } from '../../vertical.runtime-declaration.ts';

it('enrolls a current business-name export on its actual declared Privacy provider, separately from recovery', () => {
  const entrypoint = organizationBusinessNameExportRead.descriptor.entrypoint.entrypointKey;
  const requirements = (partyRegistryRuntimeManifest.requirements?.operations ?? []).filter(
    (requirement) => requirement.entrypointKey === entrypoint &&
      requirement.provider.entrypointKey === 'privacy.core.api.organization-business-applicability',
  );
  expect(requirements).toHaveLength(1);
  const edges = partyRegistryRegisteredWorkloadCalls.filter((rule) =>
    rule.sourceWorkloadKey === 'party.registry.source-read' &&
    rule.audience === 'privacy' &&
    rule.entrypointKey === 'privacy.core.api.organization-business-applicability' &&
    rule.schemaVersion === '1' && rule.legalEntityScope === 'required',
  );
  expect(edges.filter((rule) => !('allowRecoverySource' in rule && rule.allowRecoverySource))).toHaveLength(1);
  expect(edges.filter((rule) => 'allowRecoverySource' in rule && rule.allowRecoverySource)).toHaveLength(1);
});
