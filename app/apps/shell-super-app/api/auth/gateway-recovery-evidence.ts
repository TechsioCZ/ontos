import { symmyHistoricalAdmission } from '../symmy/native-evidence-policy.ts';
import { GatewayNativeEvidence } from './gateway-native-evidence.ts';

import { outboxProducerModuleKey, outboxTopic } from '@app/symmy-integration/outbox/integration-symmy-job-admitted-v1';
import { Effect, Match } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import type { GatewayDelegationRequestPayload } from './gateway-delegation-issuer.ts';
import { delegationForbidden } from './gateway-delegation-errors.ts';
import {
  gatewayPublishedOperationAccess,
  gatewayRegisteredOperationContractAllows,
} from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding, GatewayRegisteredWorkloadRule } from './gateway-delegation-policy.ts';

type RecoverySubject = Extract<GatewayDelegationRequestPayload['subject'], { readonly _tag: 'RegisteredRecovery' }>;
type RecoverySource = RecoverySubject['source'];
type InstalledContract = ShellInstalledCatalog['contracts'][number];
const sourceMatchesRule = (source: RecoverySource, rule: GatewayRegisteredWorkloadRule): boolean =>
  Match.value(source).pipe(
    Match.tag(
      'Worker',
      (worker) =>
        rule.workerKey === worker.workerKey &&
        rule.sourceActionKey === undefined &&
        rule.sourceWorkloadKey === undefined,
    ),
    Match.tag(
      'HistoricalDelivery',
      (delivery) =>
        rule.allowHistoricalDeliveryRecovery === true &&
        rule.workerKey === delivery.workerKey &&
        rule.recoveryOf?.jobKey === delivery.workerKey &&
        rule.sourceActionKey === undefined &&
        rule.sourceWorkloadKey === undefined,
    ),
    Match.tag(
      'Admission',
      (admission) =>
        rule.sourceActionKey === admission.sourceActionKey &&
        rule.workerKey === undefined &&
        rule.sourceWorkloadKey === undefined,
    ),
    Match.exhaustive,
  );

/** The historical witness currently supports only this published, versioned Symmy job envelope. */
const historicalSourceContractAllows = (source: InstalledContract, proof: RecoverySource): boolean =>
  Match.value(proof).pipe(
    Match.tag(
      'HistoricalDelivery',
      (delivery) =>
        source.manifest.module.id === outboxProducerModuleKey &&
        source.manifest.publicSurface.resourceTypes.some(
          (resource) => resource.key === 'integration.symmy.import-job',
        ) &&
        source.runtime.outboxSubscriptions.some(
          (subscription) =>
            subscription.workerKey === delivery.workerKey &&
            subscription.consumerModuleKey === outboxProducerModuleKey &&
            subscription.producerModuleKey === outboxProducerModuleKey &&
            subscription.topic === outboxTopic,
        ),
    ),
    Match.tag('Worker', () => true),
    Match.tag('Admission', () => true),
    Match.exhaustive,
  );
const readContractAllowsRecovery = (
  source: InstalledContract,
  destination: InstalledContract,
  rule: GatewayRegisteredWorkloadRule,
  legalEntityId: string | undefined,
  operationRequirementKey: string | undefined,
): boolean => {
  const access = gatewayPublishedOperationAccess(destination, rule.entrypointKey, rule.schemaVersion);
  const read = access === 'read' || access === 'historical_read';
  const write = destination.manifest.publicSurface.actions.some(
    (action) => action.entrypoint.entrypointKey === rule.entrypointKey,
  );
  return (
    read &&
    !write &&
    (operationRequirementKey !== undefined ||
      gatewayRegisteredOperationContractAllows(source, destination, rule, legalEntityId))
  );
};

/** A conditional recovery checks only the already proved source; it never reconstructs an active lease. */
export const admitRegisteredGatewayRecovery = Effect.fn('GatewayDelegation.admitRegisteredRecovery')(
  function* registeredRecovery(input: {
    readonly audience: string;
    readonly binding: GatewayModuleBinding;
    readonly installed: ShellInstalledCatalog;
    readonly subject: RecoverySubject;
  }) {
    const { binding, installed, subject } = input;
    const source = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
    const candidates = (binding.registeredWorkloads ?? []).filter(
      (rule) =>
        rule.audience === input.audience &&
        rule.declarationKey === subject.declarationKey &&
        rule.recoveryOf?.actionKey === subject.originalActionKey &&
        sourceMatchesRule(subject.source, rule),
    );
    const [rule] = candidates;
    if (
      candidates.length !== 1 ||
      rule?.recoveryOf === undefined ||
      source === undefined ||
      destination === undefined ||
      binding.compositionRevision !== installed.composition.revision ||
      binding.sourceBuildMarker !== source.deployment.buildMarker
    ) {
      return yield* delegationForbidden('registered_workload_unmatched')();
    }
    const originalAction = destination.manifest.publicSurface.actions.find(
      (action) => action.actionKey === subject.originalActionKey,
    );
    if (
      !readContractAllowsRecovery(
        source,
        destination,
        rule,
        subject.source.legalEntityId,
        subject.operationRequirementKey,
      ) ||
      originalAction === undefined ||
      !historicalSourceContractAllows(source, subject.source)
    ) {
      return yield* delegationForbidden('registered_operation_refused')();
    }
    return yield* (yield* GatewayNativeEvidence).admitRecovery({
      binding,
      destination,
      historical: symmyHistoricalAdmission,
      originalAction,
      recoveryOf: rule.recoveryOf,
      rule,
      source,
      subject,
    });
  },
);
