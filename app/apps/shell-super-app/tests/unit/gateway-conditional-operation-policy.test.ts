import { buildApplicationCompositionCatalog, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  gatewayRegisteredAdmissionOperationContractAllows,
  gatewayRegisteredOperationContractAllows,
  gatewayRegisteredWorkerOperationContractAllows,
} from '../../api/auth/gateway-delegation-policy.ts';
import type {
  GatewayConditionalOperationWitness,
  GatewayRegisteredWorkloadRule,
} from '../../api/auth/gateway-delegation-policy.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const sourceModule = 'party.registry';
const providerModule = 'privacy.core';
const sourceKey = 'party.registry.api.source';
const siblingSourceKey = 'party.registry.api.sibling';
const providerKey = 'privacy.core.api.processing-check';
const otherProviderKey = 'privacy.core.api.unrelated-check';
const requirementKey = 'party.registry.require-processing-check';
const workerKey = 'party.registry.execute-source';
const workerRequirementKey = 'party.registry.require-worker-check';
const admissionActionKey = 'party.registry.admit-source';
const admissionRequirementKey = 'party.registry.require-admission-check';
const topic = 'party.registry.source-admitted.v1';
const company = '30000000-0000-4000-8000-000000000001';
const rule: GatewayRegisteredWorkloadRule = {
  audience: 'privacy',
  declarationKey: 'privacy.core.processing-check',
  entrypointKey: providerKey,
  jobKey: 'party-privacy-check',
  legalEntityScope: 'required',
  schemaVersion: '1',
  sourceWorkloadKey: 'party.registry.source-write',
  workloadKey: 'privacy.core.source-processing-check',
};
const witness: GatewayConditionalOperationWitness = {
  requirementKey,
  sourceEntrypointKey: sourceKey,
  sourceSchemaVersion: '1',
};
const operationSurface = (moduleId: string, keys: readonly string[]) => ({
  api: [{ key: `${moduleId}.api.definition`, operationKeys: keys.map((_, index) => `operation${index}.execute`) }],
  operationContracts: keys.map((entrypointKey, index) => ({
    apiKey: `${moduleId}.api.definition`,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey,
      moduleKey: moduleId,
      role: 'api',
    }),
    operationKey: `operation${index}.execute`,
    schemaVersion: '1',
  })),
});

it.effect(
  'matches one conditional requirement to its authenticated consuming operation and exact published provider',
  () =>
    Effect.gen(function* exactConditionalOperation() {
      const sourceBase = makeModuleContractFixture({
        appId: 'party-registry',
        moduleId: sourceModule,
        outboxSubscriptions: [
          {
            consumerModuleKey: sourceModule,
            entrypoint: defineTenantModuleEntrypoint({
              access: 'background',
              authorization: { kind: 'owner_local_background' },
              entrypointKey: workerKey,
              moduleKey: sourceModule,
              role: 'worker',
            }),
            producerModuleKey: sourceModule,
            topic,
            workerKey,
          },
        ],
      });
      const providerBase = makeModuleContractFixture({ appId: 'privacy', moduleId: providerModule });
      const snapshot = yield* makeCompositionSnapshot([
        {
          ...sourceBase,
          manifest: {
            ...sourceBase.manifest,
            publicSurface: {
              ...sourceBase.manifest.publicSurface,
              actions: [
                {
                  accessWorkload: { reason: 'Exact source admission', workloads: ['party.registry.source-admission'] },
                  actionKey: admissionActionKey,
                  auditProfile: 'standard',
                  entrypoint: defineTenantModuleEntrypoint({
                    access: 'write',
                    authorization: { kind: 'protected' },
                    entrypointKey: admissionActionKey,
                    moduleKey: sourceModule,
                    role: 'action',
                  }),
                  idempotency: 'required',
                  legalEntityScope: 'optional',
                  owningModuleId: sourceModule,
                  schemaVersion: '2',
                },
              ],
              ...operationSurface(sourceModule, [sourceKey, siblingSourceKey]),
            },
            requirements: {
              coreCapabilities: [],
              intrinsic: [],
              operations: [
                {
                  condition: 'party.registry.worker-required',
                  entrypointKey: workerKey,
                  evidence: ['party.registry.worker-evidence'],
                  key: workerRequirementKey,
                  provider: { entrypointKey: providerKey, moduleId: providerModule, schemaVersion: '1' },
                },
                {
                  condition: 'party.registry.admission-required',
                  entrypointKey: admissionActionKey,
                  evidence: ['party.registry.admission-evidence'],
                  key: admissionRequirementKey,
                  provider: { entrypointKey: providerKey, moduleId: providerModule, schemaVersion: '1' },
                },
                {
                  condition: 'party.registry.processing-required',
                  entrypointKey: sourceKey,
                  evidence: ['party.registry.processing-evidence'],
                  key: requirementKey,
                  provider: { entrypointKey: providerKey, moduleId: providerModule, schemaVersion: '1' },
                },
                {
                  condition: 'party.registry.sibling-required',
                  entrypointKey: siblingSourceKey,
                  evidence: ['party.registry.sibling-evidence'],
                  key: 'party.registry.require-sibling-check',
                  provider: { entrypointKey: otherProviderKey, moduleId: providerModule, schemaVersion: '1' },
                },
              ],
              schemaVersion: '1',
            },
          },
        },
        {
          ...providerBase,
          manifest: {
            ...providerBase.manifest,
            publicSurface: {
              ...providerBase.manifest.publicSurface,
              ...operationSurface(providerModule, [providerKey, otherProviderKey]),
            },
          },
        },
      ]);
      const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
      const source = catalog.contracts.find((contract) => contract.manifest.module.id === sourceModule);
      const provider = catalog.contracts.find((contract) => contract.manifest.module.id === providerModule);
      expect(source).toBeDefined();
      expect(provider).toBeDefined();
      if (source === undefined || provider === undefined) {
        return;
      }
      expect(gatewayRegisteredOperationContractAllows(source, provider, rule, company)).toBe(false);
      expect(gatewayRegisteredOperationContractAllows(source, provider, rule, company, witness)).toBe(true);
      const rejectedWitnesses = [
        { ...witness, requirementKey: 'party.registry.missing-requirement' },
        { ...witness, sourceEntrypointKey: siblingSourceKey },
        { ...witness, sourceEntrypointKey: 'party.registry.api.unpublished' },
        { ...witness, sourceSchemaVersion: '2' },
        { ...witness, requirementKey: 'party.registry.require-sibling-check' },
      ];
      for (const rejected of rejectedWitnesses) {
        expect(gatewayRegisteredOperationContractAllows(source, provider, rule, company, rejected)).toBe(false);
      }
      expect(
        gatewayRegisteredOperationContractAllows(
          source,
          provider,
          { ...rule, entrypointKey: otherProviderKey },
          company,
          witness,
        ),
      ).toBe(false);
      expect(
        gatewayRegisteredOperationContractAllows(source, provider, { ...rule, schemaVersion: '2' }, company, witness),
      ).toBe(false);
      expect(gatewayRegisteredOperationContractAllows(source, source, rule, company, witness)).toBe(false);
      expect(gatewayRegisteredOperationContractAllows(source, provider, rule, undefined, witness)).toBe(false);
      const { sourceWorkloadKey: _sourceWorkloadKey, ...directRule } = rule;
      const workerRule = { ...directRule, workerKey };
      const admissionRule = { ...directRule, sourceActionKey: admissionActionKey };
      const workerWitness = {
        consumerModuleKey: sourceModule,
        producerModuleKey: sourceModule,
        requirementKey: workerRequirementKey,
        topic,
        workerKey,
      };
      expect(gatewayRegisteredWorkerOperationContractAllows(source, provider, workerRule, company, workerWitness)).toBe(
        true,
      );
      const invalidWorkers = [
        { ...workerWitness, requirementKey },
        { ...workerWitness, workerKey: 'party.registry.other-worker' },
        { ...workerWitness, consumerModuleKey: 'party.other' },
        { ...workerWitness, producerModuleKey: 'party.other' },
        { ...workerWitness, topic: 'party.registry.other.v1' },
      ];
      for (const invalid of invalidWorkers) {
        expect(gatewayRegisteredWorkerOperationContractAllows(source, provider, workerRule, company, invalid)).toBe(
          false,
        );
      }
      expect(
        gatewayRegisteredWorkerOperationContractAllows(
          source,
          provider,
          { ...workerRule, schemaVersion: '2' },
          company,
          workerWitness,
        ),
      ).toBe(false);
      expect(
        gatewayRegisteredWorkerOperationContractAllows(
          source,
          provider,
          { ...workerRule, entrypointKey: otherProviderKey },
          company,
          workerWitness,
        ),
      ).toBe(false);
      const admissionWitness = { admissionActionKey, requirementKey: admissionRequirementKey };
      expect(
        gatewayRegisteredAdmissionOperationContractAllows(source, provider, admissionRule, company, admissionWitness),
      ).toBe(true);
      expect(
        gatewayRegisteredAdmissionOperationContractAllows(source, provider, admissionRule, company, {
          ...admissionWitness,
          admissionActionKey: 'party.registry.other-admission',
        }),
      ).toBe(false);
      expect(
        gatewayRegisteredAdmissionOperationContractAllows(source, provider, admissionRule, company, {
          ...admissionWitness,
          requirementKey,
        }),
      ).toBe(false);
      expect(
        gatewayRegisteredAdmissionOperationContractAllows(
          source,
          provider,
          { ...admissionRule, schemaVersion: '2' },
          company,
          admissionWitness,
        ),
      ).toBe(false);
      expect(
        gatewayRegisteredAdmissionOperationContractAllows(
          source,
          provider,
          { ...admissionRule, entrypointKey: otherProviderKey },
          company,
          admissionWitness,
        ),
      ).toBe(false);
      const intrinsicSource = {
        ...source,
        manifest: {
          ...source.manifest,
          requirements: {
            coreCapabilities: [],
            intrinsic: [
              { moduleId: providerModule, requiredOperations: [{ entrypointKey: providerKey, schemaVersion: '1' }] },
            ],
            operations: [],
            schemaVersion: '1' as const,
          },
        },
      };
      expect(gatewayRegisteredOperationContractAllows(intrinsicSource, provider, rule, company)).toBe(true);
      expect(gatewayRegisteredOperationContractAllows(intrinsicSource, provider, rule, company, witness)).toBe(false);
    }),
);
