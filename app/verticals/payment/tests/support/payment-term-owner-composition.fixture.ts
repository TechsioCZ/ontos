import { createHash } from 'node:crypto';
import { GuestPaymentTermsResolutionApi } from '@app/commerce-customer-context/api/guest-payment-terms-resolution';
import { PaymentTermsResolutionApi } from '@app/commerce-customer-context/api/payment-terms-resolution';
import {
  ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY,
  OntosModuleDeploymentContractSchema,
  OntosOperationContractSchema,
  applicationCompositionContentRevision,
  canonicalOntosPublicApiKey,
  defineTenantModuleEntrypoint,
  projectOntosModuleOperationContracts,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type { ApplicationCompositionModule, OntosModuleManifestInput } from '@app/core-runtime';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
} from '@app/core-runtime/testing/module-contract';
import { Effect, Schema } from 'effect';

import { paymentManifest } from '../../vertical.manifest.ts';

const buildMarker = 'payment-term-owner-fixture';
export const paymentTermFixtureDeployment = { appId: 'payment', buildMarker } as const;
const ownerAppId = 'commerce-customer-context';
const ownerModuleId = 'commerce.customer-context';
const contractJson = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
const decodeOperation = Schema.decodeSync(OntosOperationContractSchema);

type OperationContract = ReturnType<typeof projectOntosModuleOperationContracts>[number];

const termOperation = (
  slug: string,
  group: { readonly endpoints: { readonly execute: { readonly identifier: string } }; readonly identifier: string },
) =>
  decodeOperation({
    apiKey: canonicalOntosPublicApiKey(ownerModuleId, slug),
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: `${ownerModuleId}.api.${slug}`,
      moduleKey: ownerModuleId,
      role: 'api',
    }),
    operationKey: `${group.identifier}.${group.endpoints.execute.identifier}`,
    schemaVersion: '1',
  });

const cccTermContractFixture = [
  termOperation('payment-terms-resolution', PaymentTermsResolutionApi.groups.paymentTermsResolution),
  termOperation('guest-payment-terms-resolution', GuestPaymentTermsResolutionApi.groups.guestPaymentTermsResolution),
];

const contractDocumentOf = (
  appId: string,
  moduleId: string,
  operations: readonly OperationContract[],
  requirements: OntosModuleManifestInput['requirements'],
) => {
  const base = makeModuleContractFixture({ appId, buildMarker, moduleId });
  const api = [...new Set(operations.map(({ apiKey }) => apiKey))].map((key) => ({
    key,
    operationKeys: operations.filter(({ apiKey }) => apiKey === key).map(({ operationKey }) => operationKey),
  }));
  const projected = {
    ...base.manifest,
    publicSurface: { ...base.manifest.publicSurface, api, operationContracts: operations },
  };
  return Schema.decodeEffect(OntosModuleDeploymentContractSchema)({
    ...base,
    manifest: requirements === undefined ? projected : { ...projected, requirements },
  }).pipe(Effect.flatMap(Schema.encodeEffect(contractJson)));
};

const project = Effect.fn('PaymentTermOwnerTest.projectContract')(function* project(
  module: ApplicationCompositionModule,
) {
  const selectedAppId = module.deployment.appId;
  const isPayment = selectedAppId === paymentTermFixtureDeployment.appId;
  const moduleId = isPayment ? paymentManifest.module.id : ownerModuleId;
  const requirements = isPayment ? paymentManifest.requirements : undefined;
  const operations = isPayment ? projectOntosModuleOperationContracts(paymentManifest) : cccTermContractFixture;
  const contractDocument = yield* contractDocumentOf(selectedAppId, moduleId, operations, requirements);
  const sha256 = createHash('sha256').update(contractDocument).digest('hex');
  return {
    ...module,
    contract: { ...module.contract, sha256 },
    contractDocument,
    moduleId,
    publicContract: { ...module.publicContract, id: moduleId, sha256 },
    requiredCoreCapabilities: requirements?.coreCapabilities ?? [],
  };
});

/** Admit the actual Payment declarations and fixtures of CCC's public Read contracts into a test composition. */
export const makePaymentTermOwnerComposition = Effect.fn('PaymentTermOwnerTest.composition')(function* compose() {
  const { appId } = paymentTermFixtureDeployment;
  const snapshot = yield* makeApplicationCompositionSnapshotFixture([appId, ownerAppId], buildMarker);
  const modules = yield* Effect.all(snapshot.composition.modules.map((module) => project(module)));
  const composition = {
    ...snapshot.composition,
    modules,
    shell: {
      ...snapshot.composition.shell,
      coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
    },
  };
  return yield* validateActiveApplicationCompositionSnapshot({
    ...snapshot,
    composition: { ...composition, revision: yield* applicationCompositionContentRevision(composition) },
  });
});
