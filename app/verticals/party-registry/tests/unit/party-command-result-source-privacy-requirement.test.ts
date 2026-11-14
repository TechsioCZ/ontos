import { extractVerticalRuntimeSafeDescriptors, requireModuleOperation } from '@app/core-runtime';
import type { InstalledModuleCatalog } from '@app/core-runtime';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { getVerticalRuntimeReads } from '../../../../packages/core-runtime/src/modules/runtime-registration.ts';
import { withModuleOperationExecution } from '../../../../packages/core-runtime/src/modules/module-operation-execution.ts';
import { partyCommandResultRead } from '../../src/api/party-command-result.read.ts';
import { partyMatchDecisionRead } from '../../src/api/party-match-decision.read.ts';
import { partySourcePrivacyRequirementKey } from '../../src/services/party-client-source-privacy.service.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';

const ownerDescriptors = extractVerticalRuntimeSafeDescriptors(partyRegistryBackendRegistration);
const commandResultEntrypointKey = partyCommandResultRead.descriptor.entrypoint.entrypointKey;
const commandResultRequirementKey = partySourcePrivacyRequirementKey(commandResultEntrypointKey);

const installedCatalog = () => {
  const operations = ownerDescriptors.requirements?.operations ?? [];
  const modules = new Map<string, unknown>([[ownerDescriptors.moduleId, { manifest: ownerDescriptors }]]);
  for (const { provider } of operations) {
    modules.set(provider.moduleId, {
      manifest: {
        publicSurface: {
          operationContracts: operations.map((operation) => ({
            entrypoint: { entrypointKey: operation.provider.entrypointKey },
            schemaVersion: operation.provider.schemaVersion,
          })),
        },
      },
    });
  }
  // SAFETY: the operation requirement check reads only getByModuleId(...).manifest requirements and contracts.
  return { getByModuleId: (moduleId: string) => modules.get(moduleId) } as unknown as InstalledModuleCatalog;
};

const executing = (registration: typeof partyCommandResultRead | typeof partyMatchDecisionRead) =>
  withModuleOperationExecution(
    {
      loadCatalog: Effect.succeed(installedCatalog()),
      ownerRegistration: partyRegistryBackendRegistration,
      phase: 'execution',
      registration,
      revision: 'a'.repeat(64),
      scope: { tenantId: 'trusted-tenant' },
    },
    requireModuleOperation(commandResultRequirementKey),
  );

it.effect('Create recovery resolves its own source Privacy requirement as a registered owner Read', () =>
  Effect.gen(function* commandResultRequirement() {
    expect(getVerticalRuntimeReads(partyRegistryBackendRegistration)).toContain(partyCommandResultRead);
    expect(
      ownerDescriptors.requirements?.operations.find(({ key }) => key === commandResultRequirementKey),
    ).toMatchObject({
      condition: 'party.registry.condition.client-source-processing',
      entrypointKey: commandResultEntrypointKey,
      provider: { entrypointKey: 'privacy.core.api.source-processing-eligibility', moduleId: 'privacy.core' },
    });
    expect(yield* executing(partyCommandResultRead)).toBeUndefined();
    // The requirement binds only the recovery Read's own entrypoint.
    expect(yield* Effect.flip(executing(partyMatchDecisionRead))).toMatchObject({
      code: 'module_operation_requirement_unsatisfied',
    });
  }),
);

it('keeps the Create recovery Read private: runtime membership publishes no operation contract', () => {
  expect(
    ownerDescriptors.operationContracts.some(
      ({ entrypoint }) => entrypoint.entrypointKey === commandResultEntrypointKey,
    ),
  ).toBe(false);
});
