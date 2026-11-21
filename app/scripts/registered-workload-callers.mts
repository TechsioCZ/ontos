import { Array as EffectArray, Order, Result, Schema } from 'effect';

import {
  OntosRegisteredWorkloadCallSchema,
  registeredWorkloadCallReceiverIssue,
} from '../packages/core-runtime/src/index.ts';
import type {
  OntosRegisteredWorkloadCall,
  RegisteredWorkloadCallReceiver,
} from '../packages/core-runtime/src/index.ts';

/**
 * Every registered-workload call a module declares must reach a deployment whose published operation version declares
 * that declaration for that workload, in the scope of a receiving action. The Shell drops any other call at runtime
 * too. Returns one issue per call that is not received; the module contract check fails on any.
 */
export const registeredWorkloadCallReceiptIssues = (
  contracts: readonly (RegisteredWorkloadCallReceiver & {
    readonly manifest: {
      readonly registeredWorkloadCalls?: readonly Parameters<typeof registeredWorkloadCallReceiverIssue>[0][];
    };
  })[],
): readonly string[] =>
  contracts.flatMap((caller) =>
    (caller.manifest.registeredWorkloadCalls ?? []).flatMap((call) => {
      const issue = registeredWorkloadCallReceiverIssue(
        call,
        contracts.find((candidate) => candidate.deployment.appId === call.audience),
      );
      return issue === undefined ? [] : [`${caller.deployment.appId} ${issue}`];
    }),
  );

const symmyIntegration = 'symmy-integration';
const customerContext = 'commerce-customer-context';
/**
 * The reviewed callers of each registered workload. A receiver admits a registered workload, not a calling module, so
 * without this table any module could declare a call as another module's workload and act as its principal wherever a
 * tenant registered that workload (for example as Symmy's `commerce.customer-context.source-write`, which lets Customer
 * Context's owner overlay skip its Counterparty grant check). Derived from the declarations in
 * `verticals/*\/src/registered-workload-calls.ts`; a new workload, or a new caller of an existing one, needs a reviewed
 * entry here. Every write workload has exactly one caller; the five shared workloads are read or check workloads that
 * the fixtures give to several source modules.
 */
export const REVIEWED_REGISTERED_WORKLOAD_CALLERS: ReadonlyMap<string, readonly [string, ...string[]]> = new Map<
  string,
  readonly [string, ...string[]]
>([
  ['commerce.assortment.symmy-fixture-currentness', ['assortment']],
  ['commerce.assortment.symmy-fixture-rule-import', [symmyIntegration]],
  ['commerce.catalog.symmy-product-import', [symmyIntegration]],
  ['commerce.catalog.symmy-product-localized-facts', [symmyIntegration]],
  ['commerce.catalog.symmy-product-localized-facts-recovery', [symmyIntegration]],
  ['commerce.catalog.symmy-product-read', ['pricing', symmyIntegration]],
  ['commerce.catalog.symmy-variant-localized-facts', [symmyIntegration]],
  ['commerce.catalog.symmy-variant-localized-facts-recovery', [symmyIntegration]],
  ['commerce.customer-context.organization-ico-facts.read', ['privacy']],
  ['commerce.customer-context.source-read', [symmyIntegration]],
  ['commerce.customer-context.source-write', [symmyIntegration]],
  ['commerce.inventory.source-read', [symmyIntegration]],
  ['commerce.inventory.source-write', [symmyIntegration]],
  ['commerce.market-catalog.source-read', ['pricing']],
  ['commerce.pricing.source-read', [symmyIntegration]],
  ['commerce.pricing.source-write', [symmyIntegration]],
  ['commerce.tax.symmy-seller-vat-fixture-import', [symmyIntegration]],
  ['integration.symmy.source-organization-facts.read', ['privacy']],
  ['party.registry.source-read', [customerContext, 'privacy', symmyIntegration]],
  ['party.registry.source-write', [symmyIntegration]],
  ['payment.source-ingress', ['payment']],
  ['pricing.price-group-catalog.source-read', [customerContext, symmyIntegration]],
  ['pricing.price-group-catalog.source-write', [symmyIntegration]],
  ['privacy.core.organization-business-check', [customerContext, 'party-registry']],
  ['privacy.core.organization-profile-ico-check', [customerContext]],
  ['privacy.core.source-processing-check', [customerContext, 'party-registry', symmyIntegration]],
]);

/**
 * Every registered-workload call is declared by a reviewed caller of its workload: a workload without a reviewed
 * entry, or a module the entry does not name (a second declarer of a one-caller workload included), is an issue.
 */
export const registeredWorkloadCallerIssues = (
  contracts: readonly {
    readonly deployment: { readonly appId: string };
    readonly manifest: { readonly registeredWorkloadCalls?: readonly { readonly workloadKey: string }[] };
  }[],
  reviewedCallers: ReadonlyMap<string, readonly string[]> = REVIEWED_REGISTERED_WORKLOAD_CALLERS,
): readonly string[] =>
  contracts.flatMap(({ deployment: { appId }, manifest }) =>
    (manifest.registeredWorkloadCalls ?? []).flatMap(({ workloadKey }) => {
      const callers = reviewedCallers.get(workloadKey);
      if (callers === undefined) {
        return [`${appId} declares a call as registered workload ${workloadKey}, which has no reviewed caller`];
      }
      return callers.includes(appId)
        ? []
        : [
            `${appId} declares a call as registered workload ${workloadKey}, whose reviewed callers are ${callers.join(', ')}`,
          ];
    }),
  );

/**
 * The complete registered-workload call declarations each calling module's built contract records, one canonical
 * declaration per entry (`canonicalRegisteredWorkloadCall`): every field that decides what the call may do, its
 * workload, receiver, declaration, version, entrypoint, job, legal-entity scope, source workload, worker, source
 * action, recovery identity and recovery flags. A new, removed or changed declaration of any of them, a changed
 * selector included, is a visible diff here; the module contract check and the generation test compare the built
 * contracts with it. Written out from `verticals/*\/src/registered-workload-calls.ts` and reviewed against them.
 */
export const REVIEWED_REGISTERED_WORKLOAD_CALLS = {
  assortment: [
    '{"audience":"catalog","declarationKey":"commerce.catalog.assortment-product-classification-v1.read","entrypointKey":"commerce.catalog.api.assortment-product-classification-v1","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","sourceWorkloadKey":"commerce.assortment.symmy-fixture-rule-import","workloadKey":"commerce.assortment.symmy-fixture-currentness"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-group.read","entrypointKey":"commerce.customer-context.api.customer-group-detail","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.assortment.symmy-fixture-rule-import","workloadKey":"commerce.assortment.symmy-fixture-currentness"}',
    '{"audience":"commerce-market-catalog","declarationKey":"commerce.market-catalog.assortment-fixture-market-association.read","entrypointKey":"commerce.market-catalog.api.assortment-fixture-market-association","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.assortment.symmy-fixture-rule-import","workloadKey":"commerce.assortment.symmy-fixture-currentness"}',
    '{"audience":"storefront-registry","declarationKey":"commerce.storefront-registry.storefront-application.read-current","entrypointKey":"commerce.storefront-registry.api.current-storefront-application","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"commerce.assortment.symmy-fixture-rule-import","workloadKey":"commerce.assortment.symmy-fixture-currentness"}',
  ],
  'commerce-customer-context': [
    '{"allowRecoverySource":true,"audience":"party-registry","declarationKey":"party.registry.counterparty-organization-ico-facts.read","entrypointKey":"party.registry.api.counterparty-organization-ico-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.organization-ico-facts.read","workloadKey":"party.registry.source-read"}',
    '{"allowRecoverySource":true,"audience":"party-registry","declarationKey":"party.registry.source-counterparty-admission.read","entrypointKey":"party.registry.api.source-counterparty-admission","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-read","workloadKey":"party.registry.source-read"}',
    '{"allowRecoverySource":true,"audience":"party-registry","declarationKey":"party.registry.source-person-admission.read","entrypointKey":"party.registry.api.source-person-admission","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-read","workloadKey":"party.registry.source-read"}',
    '{"allowRecoverySource":true,"audience":"privacy","declarationKey":"privacy.core.organization-business-applicability.read","entrypointKey":"privacy.core.api.organization-business-applicability","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-read","workloadKey":"privacy.core.organization-business-check"}',
    '{"allowRecoverySource":true,"audience":"privacy","declarationKey":"privacy.core.organization-profile-ico-applicability.read","entrypointKey":"privacy.core.api.organization-profile-ico-applicability","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-read","workloadKey":"privacy.core.organization-profile-ico-check"}',
    '{"allowRecoverySource":true,"audience":"privacy","declarationKey":"privacy.core.source-processing-eligibility.read","entrypointKey":"privacy.core.api.source-processing-eligibility","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-read","workloadKey":"privacy.core.source-processing-check"}',
    '{"audience":"party-registry","declarationKey":"party.registry.counterparty-organization-ico-facts.read","entrypointKey":"party.registry.api.counterparty-organization-ico-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.organization-ico-facts.read","workloadKey":"party.registry.source-read"}',
    '{"audience":"party-registry","declarationKey":"party.registry.source-counterparty-admission.read","entrypointKey":"party.registry.api.source-counterparty-admission","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-read","workloadKey":"party.registry.source-read"}',
    '{"audience":"party-registry","declarationKey":"party.registry.source-counterparty-admission.read","entrypointKey":"party.registry.api.source-counterparty-admission","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-write","workloadKey":"party.registry.source-read"}',
    '{"audience":"party-registry","declarationKey":"party.registry.source-person-admission.read","entrypointKey":"party.registry.api.source-person-admission","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-read","workloadKey":"party.registry.source-read"}',
    '{"audience":"party-registry","declarationKey":"party.registry.source-person-admission.read","entrypointKey":"party.registry.api.source-person-admission","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-write","workloadKey":"party.registry.source-read"}',
    '{"audience":"price-group-catalog","declarationKey":"pricing.price-group-catalog.price-group.read.compatibility","entrypointKey":"pricing.price-group-catalog.api.validate-price-group-compatibility","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-write","workloadKey":"pricing.price-group-catalog.source-read"}',
    '{"audience":"privacy","declarationKey":"privacy.core.organization-business-applicability.read","entrypointKey":"privacy.core.api.organization-business-applicability","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-read","workloadKey":"privacy.core.organization-business-check"}',
    '{"audience":"privacy","declarationKey":"privacy.core.organization-business-applicability.read","entrypointKey":"privacy.core.api.organization-business-applicability","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-write","workloadKey":"privacy.core.organization-business-check"}',
    '{"audience":"privacy","declarationKey":"privacy.core.organization-profile-ico-applicability.read","entrypointKey":"privacy.core.api.organization-profile-ico-applicability","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-read","workloadKey":"privacy.core.organization-profile-ico-check"}',
    '{"audience":"privacy","declarationKey":"privacy.core.organization-profile-ico-applicability.read","entrypointKey":"privacy.core.api.organization-profile-ico-applicability","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-write","workloadKey":"privacy.core.organization-profile-ico-check"}',
    '{"audience":"privacy","declarationKey":"privacy.core.source-processing-eligibility.read","entrypointKey":"privacy.core.api.source-processing-eligibility","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-read","workloadKey":"privacy.core.source-processing-check"}',
    '{"audience":"privacy","declarationKey":"privacy.core.source-processing-eligibility.read","entrypointKey":"privacy.core.api.source-processing-eligibility","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.customer-context.source-write","workloadKey":"privacy.core.source-processing-check"}',
  ],
  'party-registry': [
    '{"allowRecoverySource":true,"audience":"privacy","declarationKey":"privacy.core.organization-business-applicability.read","entrypointKey":"privacy.core.api.organization-business-applicability","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"party.registry.source-read","workloadKey":"privacy.core.organization-business-check"}',
    '{"allowRecoverySource":true,"audience":"privacy","declarationKey":"privacy.core.source-processing-eligibility.read","entrypointKey":"privacy.core.api.source-processing-eligibility","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"party.registry.source-read","workloadKey":"privacy.core.source-processing-check"}',
    '{"audience":"privacy","declarationKey":"privacy.core.organization-business-applicability.read","entrypointKey":"privacy.core.api.organization-business-applicability","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"party.registry.source-write","workloadKey":"privacy.core.organization-business-check"}',
    '{"audience":"privacy","declarationKey":"privacy.core.source-processing-eligibility.read","entrypointKey":"privacy.core.api.source-processing-eligibility","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"party.registry.source-read","workloadKey":"privacy.core.source-processing-check"}',
    '{"audience":"privacy","declarationKey":"privacy.core.source-processing-eligibility.read","entrypointKey":"privacy.core.api.source-processing-eligibility","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"party.registry.source-write","workloadKey":"privacy.core.source-processing-check"}',
  ],
  payment: [
    '{"audience":"payment","declarationKey":"payment.core.observation.accept","entrypointKey":"payment.core.accept-payment-observation","jobKey":"payment.core.process-provider-notification","legalEntityScope":"required","schemaVersion":"1","workerKey":"payment.core.process-provider-notification","workloadKey":"payment.source-ingress"}',
    '{"audience":"payment","declarationKey":"payment.core.observation.accept","entrypointKey":"payment.core.accept-payment-observation","jobKey":"payment.core.recover-gateway-operation","legalEntityScope":"required","schemaVersion":"1","workerKey":"payment.core.recover-gateway-operation","workloadKey":"payment.source-ingress"}',
  ],
  pricing: [
    '{"audience":"catalog","declarationKey":"commerce.catalog.selection-evidence.read","entrypointKey":"commerce.catalog.api.selection-evidence","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","sourceWorkloadKey":"commerce.pricing.source-write","workloadKey":"commerce.catalog.symmy-product-read"}',
    '{"audience":"commerce-market-catalog","declarationKey":"commerce.market-catalog.market-catalog.read","entrypointKey":"commerce.market-catalog.api.current-market-catalog","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"commerce.pricing.source-write","workloadKey":"commerce.market-catalog.source-read"}',
  ],
  privacy: [
    '{"allowRecoverySource":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-profile-organization-ico-facts.read","entrypointKey":"commerce.customer-context.api.customer-profile-organization-ico-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"privacy.core.organization-business-check","workloadKey":"commerce.customer-context.organization-ico-facts.read"}',
    '{"allowRecoverySource":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-profile-organization-ico-facts.read","entrypointKey":"commerce.customer-context.api.customer-profile-organization-ico-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"privacy.core.organization-profile-ico-check","workloadKey":"commerce.customer-context.organization-ico-facts.read"}',
    '{"allowRecoverySource":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-profile-organization-ico-facts.read","entrypointKey":"commerce.customer-context.api.customer-profile-organization-ico-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"privacy.core.source-processing-check","workloadKey":"commerce.customer-context.organization-ico-facts.read"}',
    '{"allowRecoverySource":true,"audience":"party-registry","declarationKey":"party.registry.organization-ico-facts.read","entrypointKey":"party.registry.api.organization-ico-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"privacy.core.organization-profile-ico-check","workloadKey":"party.registry.source-read"}',
    '{"allowRecoverySource":true,"audience":"party-registry","declarationKey":"party.registry.organization-record-facts.read","entrypointKey":"party.registry.api.organization-record-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"privacy.core.organization-business-check","workloadKey":"party.registry.source-read"}',
    '{"allowRecoverySource":true,"audience":"party-registry","declarationKey":"party.registry.organization-record-facts.read","entrypointKey":"party.registry.api.organization-record-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"privacy.core.source-processing-check","workloadKey":"party.registry.source-read"}',
    '{"allowRecoverySource":true,"audience":"party-registry","declarationKey":"party.registry.source-person-admission.read","entrypointKey":"party.registry.api.source-person-admission","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"privacy.core.source-processing-check","workloadKey":"party.registry.source-read"}',
    '{"allowRecoverySource":true,"audience":"symmy-integration","declarationKey":"integration.symmy.symmy-source-organization-facts.read","entrypointKey":"integration.symmy.api.symmy-source-organization-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"privacy.core.organization-business-check","workloadKey":"integration.symmy.source-organization-facts.read"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-profile-organization-ico-facts.read","entrypointKey":"commerce.customer-context.api.customer-profile-organization-ico-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"privacy.core.organization-business-check","workloadKey":"commerce.customer-context.organization-ico-facts.read"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-profile-organization-ico-facts.read","entrypointKey":"commerce.customer-context.api.customer-profile-organization-ico-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"privacy.core.organization-profile-ico-check","workloadKey":"commerce.customer-context.organization-ico-facts.read"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-profile-organization-ico-facts.read","entrypointKey":"commerce.customer-context.api.customer-profile-organization-ico-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"privacy.core.source-processing-check","workloadKey":"commerce.customer-context.organization-ico-facts.read"}',
    '{"audience":"party-registry","declarationKey":"party.registry.organization-ico-facts.read","entrypointKey":"party.registry.api.organization-ico-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"privacy.core.organization-profile-ico-check","workloadKey":"party.registry.source-read"}',
    '{"audience":"party-registry","declarationKey":"party.registry.organization-record-facts.read","entrypointKey":"party.registry.api.organization-record-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"privacy.core.organization-business-check","workloadKey":"party.registry.source-read"}',
    '{"audience":"party-registry","declarationKey":"party.registry.organization-record-facts.read","entrypointKey":"party.registry.api.organization-record-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"privacy.core.source-processing-check","workloadKey":"party.registry.source-read"}',
    '{"audience":"party-registry","declarationKey":"party.registry.source-person-admission.read","entrypointKey":"party.registry.api.source-person-admission","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","sourceWorkloadKey":"privacy.core.source-processing-check","workloadKey":"party.registry.source-read"}',
    '{"audience":"symmy-integration","declarationKey":"integration.symmy.symmy-source-organization-facts.read","entrypointKey":"integration.symmy.api.symmy-source-organization-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceWorkloadKey":"privacy.core.organization-business-check","workloadKey":"integration.symmy.source-organization-facts.read"}',
  ],
  'symmy-integration': [
    '{"allowHistoricalDeliveryRecovery":true,"audience":"catalog","declarationKey":"commerce.catalog.create-product-recovery.read","entrypointKey":"commerce.catalog.api.create-product-recovery","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","recoveryOf":{"actionKey":"commerce.catalog.create-product","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-product-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"catalog","declarationKey":"commerce.catalog.create-variant-recovery.read","entrypointKey":"commerce.catalog.api.create-variant-recovery","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","recoveryOf":{"actionKey":"commerce.catalog.create-variant","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-product-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"catalog","declarationKey":"commerce.catalog.update-product-recovery.read","entrypointKey":"commerce.catalog.api.update-product-recovery","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","recoveryOf":{"actionKey":"commerce.catalog.update-product","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-product-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-group-membership-source-receipt.read","entrypointKey":"commerce.customer-context.api.customer-group-membership-source-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.apply-customer-group-membership-source","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-price-group-assignment-receipt.read","entrypointKey":"commerce.customer-context.api.customer-price-group-assignment-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.assign-counterparty-price-group","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-price-group-assignment-receipt.read","entrypointKey":"commerce.customer-context.api.customer-price-group-assignment-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.assign-customer-price-group","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-profile-source.read","entrypointKey":"commerce.customer-context.api.customer-profile-source","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.create-counterparty-purchasing-profile","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-profile-source.read","entrypointKey":"commerce.customer-context.api.customer-profile-source","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.ensure-retail-customer-profile","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.organization-customer-profile-ico.read","entrypointKey":"commerce.customer-context.api.organization-customer-profile-ico","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.change-organization-customer-profile-ico","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.saved-address-source-receipt.read","entrypointKey":"commerce.customer-context.api.saved-address-source-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.add-saved-address","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.saved-address-source-receipt.read","entrypointKey":"commerce.customer-context.api.saved-address-source-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.remove-saved-address","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.saved-address-source-receipt.read","entrypointKey":"commerce.customer-context.api.saved-address-source-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.update-saved-address","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"party-registry","declarationKey":"party.registry.party-source-effect-receipt.read","entrypointKey":"party.registry.api.party-source-effect-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","recoveryOf":{"actionKey":"party.registry.add-contact-point","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"party.registry.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"party-registry","declarationKey":"party.registry.party-source-effect-receipt.read","entrypointKey":"party.registry.api.party-source-effect-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","recoveryOf":{"actionKey":"party.registry.counterparty-customer-onboard","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"party.registry.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"party-registry","declarationKey":"party.registry.party-source-effect-receipt.read","entrypointKey":"party.registry.api.party-source-effect-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","recoveryOf":{"actionKey":"party.registry.create-party","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"party.registry.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"party-registry","declarationKey":"party.registry.party-source-effect-receipt.read","entrypointKey":"party.registry.api.party-source-effect-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","recoveryOf":{"actionKey":"party.registry.update-party","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"party.registry.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"price-group-catalog","declarationKey":"pricing.price-group-catalog.price-group-result-lookup.read","entrypointKey":"pricing.price-group-catalog.api.price-group-result-lookup","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","recoveryOf":{"actionKey":"pricing.price-group-catalog.create-price-group","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"pricing.price-group-catalog.source-read"}',
    '{"allowHistoricalDeliveryRecovery":true,"audience":"pricing","declarationKey":"commerce.pricing.price-source-result-lookup.read","entrypointKey":"commerce.pricing.api.price-source-result-lookup","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.pricing.define-price","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.pricing.source-read"}',
    '{"audience":"assortment","declarationKey":"commerce.assortment.symmy-fixture-rule.import","entrypointKey":"commerce.assortment.import-symmy-rule","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.assortment.symmy-fixture-rule-import"}',
    '{"audience":"catalog","declarationKey":"commerce.catalog.catalog-source-product-page.read","entrypointKey":"commerce.catalog.api.catalog-source-product-page","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-product-read"}',
    '{"audience":"catalog","declarationKey":"commerce.catalog.catalog-source-products.read","entrypointKey":"commerce.catalog.api.catalog-source-products","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-product-read"}',
    '{"audience":"catalog","declarationKey":"commerce.catalog.product-localized-facts.set","entrypointKey":"commerce.catalog.set-product-localized-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-product-localized-facts"}',
    '{"audience":"catalog","declarationKey":"commerce.catalog.product.create","entrypointKey":"commerce.catalog.create-product","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"2","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-product-import"}',
    '{"audience":"catalog","declarationKey":"commerce.catalog.product.update","entrypointKey":"commerce.catalog.update-product","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-product-import"}',
    '{"audience":"catalog","declarationKey":"commerce.catalog.set-product-localized-facts-recovery.read","entrypointKey":"commerce.catalog.api.set-product-localized-facts-recovery","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","recoveryOf":{"actionKey":"commerce.catalog.set-product-localized-facts","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-product-localized-facts-recovery"}',
    '{"audience":"catalog","declarationKey":"commerce.catalog.set-variant-localized-facts-recovery.read","entrypointKey":"commerce.catalog.api.set-variant-localized-facts-recovery","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","recoveryOf":{"actionKey":"commerce.catalog.set-variant-localized-facts","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-variant-localized-facts-recovery"}',
    '{"audience":"catalog","declarationKey":"commerce.catalog.variant-localized-facts.set","entrypointKey":"commerce.catalog.set-variant-localized-facts","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-variant-localized-facts"}',
    '{"audience":"catalog","declarationKey":"commerce.catalog.variant.create","entrypointKey":"commerce.catalog.create-variant","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"2","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.catalog.symmy-product-import"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.counterparty-price-group.assign","entrypointKey":"commerce.customer-context.assign-counterparty-price-group","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.counterparty-purchasing-profile.create","entrypointKey":"commerce.customer-context.create-counterparty-purchasing-profile","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-group-definition-source.read","entrypointKey":"commerce.customer-context.api.customer-group-definition-source","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.create-customer-group","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","sourceActionKey":"integration.symmy.admit-symmy-sync","workloadKey":"commerce.customer-context.source-read"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-group-definition-source.read","entrypointKey":"commerce.customer-context.api.customer-group-definition-source","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.customer-context.update-customer-group","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","sourceActionKey":"integration.symmy.admit-symmy-sync","workloadKey":"commerce.customer-context.source-read"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-group-definition-source.read","entrypointKey":"commerce.customer-context.api.customer-group-definition-source","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceActionKey":"integration.symmy.admit-symmy-sync","workloadKey":"commerce.customer-context.source-read"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-group-definition-source.read","entrypointKey":"commerce.customer-context.api.customer-group-definition-source","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-group-membership-source.apply","entrypointKey":"commerce.customer-context.apply-customer-group-membership-source","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-group.create","entrypointKey":"commerce.customer-context.create-customer-group","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceActionKey":"integration.symmy.admit-symmy-sync","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-group.create","entrypointKey":"commerce.customer-context.create-customer-group","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-group.update","entrypointKey":"commerce.customer-context.update-customer-group","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","sourceActionKey":"integration.symmy.admit-symmy-sync","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-price-group.assign","entrypointKey":"commerce.customer-context.assign-customer-price-group","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.customer-profile-source.read","entrypointKey":"commerce.customer-context.api.customer-profile-source","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-read"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.organization-customer-profile-ico.change","entrypointKey":"commerce.customer-context.change-organization-customer-profile-ico","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.retail-customer-profile.ensure","entrypointKey":"commerce.customer-context.ensure-retail-customer-profile","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.saved-address.add","entrypointKey":"commerce.customer-context.add-saved-address","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.saved-address.remove","entrypointKey":"commerce.customer-context.remove-saved-address","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"commerce-customer-context","declarationKey":"commerce.customer-context.saved-address.update","entrypointKey":"commerce.customer-context.update-saved-address","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.customer-context.source-write"}',
    '{"audience":"inventory","declarationKey":"commerce.inventory.inventory-source-import-receipt.read","entrypointKey":"commerce.inventory.api.inventory-source-import-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","recoveryOf":{"actionKey":"commerce.inventory.import-source-assertion","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","sourceActionKey":"integration.symmy.admit-symmy-sync","workloadKey":"commerce.inventory.source-read"}',
    '{"audience":"inventory","declarationKey":"commerce.inventory.inventory-source-import-receipt.read","entrypointKey":"commerce.inventory.api.inventory-source-import-receipt","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","sourceActionKey":"integration.symmy.admit-symmy-sync","workloadKey":"commerce.inventory.source-read"}',
    '{"audience":"inventory","declarationKey":"commerce.inventory.source-assertion.import","entrypointKey":"commerce.inventory.import-source-assertion","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","sourceActionKey":"integration.symmy.admit-symmy-sync","workloadKey":"commerce.inventory.source-write"}',
    '{"audience":"party-registry","declarationKey":"party.registry.contact-point.add","entrypointKey":"party.registry.add-contact-point","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"party.registry.source-write"}',
    '{"audience":"party-registry","declarationKey":"party.registry.counterparty.onboard","entrypointKey":"party.registry.counterparty-customer-onboard","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"party.registry.source-write"}',
    '{"audience":"party-registry","declarationKey":"party.registry.party.create","entrypointKey":"party.registry.create-party","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"party.registry.source-write"}',
    '{"audience":"party-registry","declarationKey":"party.registry.party.update","entrypointKey":"party.registry.update-party","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"optional","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"party.registry.source-write"}',
    '{"audience":"price-group-catalog","declarationKey":"pricing.price-group-catalog.price-group-catalog-head.read","entrypointKey":"pricing.price-group-catalog.api.price-group-catalog-head","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"pricing.price-group-catalog.source-read"}',
    '{"audience":"price-group-catalog","declarationKey":"pricing.price-group-catalog.price-group-definition-revision.create","entrypointKey":"pricing.price-group-catalog.create-price-group-definition-revision","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"pricing.price-group-catalog.source-write"}',
    '{"audience":"price-group-catalog","declarationKey":"pricing.price-group-catalog.price-group-result-lookup.read","entrypointKey":"pricing.price-group-catalog.api.price-group-result-lookup","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","recoveryOf":{"actionKey":"pricing.price-group-catalog.create-price-group-definition-revision","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"pricing.price-group-catalog.source-read"}',
    '{"audience":"price-group-catalog","declarationKey":"pricing.price-group-catalog.price-group-source-associations.read","entrypointKey":"pricing.price-group-catalog.api.price-group-source-associations","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"pricing.price-group-catalog.source-read"}',
    '{"audience":"price-group-catalog","declarationKey":"pricing.price-group-catalog.price-group.create","entrypointKey":"pricing.price-group-catalog.create-price-group","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"forbidden","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"pricing.price-group-catalog.source-write"}',
    '{"audience":"pricing","declarationKey":"commerce.pricing.price-source-result-lookup.read","entrypointKey":"commerce.pricing.api.price-source-result-lookup","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","recoveryOf":{"actionKey":"commerce.pricing.revise-price","jobKey":"integration.symmy.execute-symmy-job"},"schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.pricing.source-read"}',
    '{"audience":"pricing","declarationKey":"commerce.pricing.price.define","entrypointKey":"commerce.pricing.define-price","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"2","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.pricing.source-write"}',
    '{"audience":"pricing","declarationKey":"commerce.pricing.price.read-definition","entrypointKey":"commerce.pricing.api.price-definition","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.pricing.source-read"}',
    '{"audience":"pricing","declarationKey":"commerce.pricing.price.revise","entrypointKey":"commerce.pricing.revise-price","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"2","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.pricing.source-write"}',
    '{"audience":"privacy","declarationKey":"privacy.core.source-processing-eligibility.read","entrypointKey":"privacy.core.api.source-processing-eligibility","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"privacy.core.source-processing-check"}',
    '{"audience":"tax","declarationKey":"commerce.tax.seller-vat-regime-declaration.import","entrypointKey":"commerce.tax.import-seller-vat-regime-declarations","jobKey":"integration.symmy.execute-symmy-job","legalEntityScope":"required","schemaVersion":"1","workerKey":"integration.symmy.execute-symmy-job","workloadKey":"commerce.tax.symmy-seller-vat-fixture-import"}',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const encodeCall = Schema.encodeResult(Schema.fromJsonString(OntosRegisteredWorkloadCallSchema));

/**
 * One complete call declaration as the JSON its owning schema encodes, fields in the schema's order and an absent
 * optional field left out, so two declarations read alike exactly when every field is alike. A declaration the schema
 * refuses reads as its refusal, which no reviewed entry matches.
 */
export const canonicalRegisteredWorkloadCall = (call: OntosRegisteredWorkloadCall): string =>
  Result.match(encodeCall(call), {
    onFailure: (error) => `invalid registered-workload call: ${error.message}`,
    onSuccess: (json) => json,
  });

const countingCalls = (calls: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const call of calls) {
    counts.set(call, (counts.get(call) ?? 0) + 1);
  }
  return counts;
};

/**
 * Every complete call declaration one built contract records a different number of times than the reviewed inventory:
 * `built` 0 is a reviewed declaration the contract lost, `reviewed` 0 a declaration nobody reviewed, so a changed field
 * shows as both. A module the inventory does not name reviews none.
 */
export const registeredWorkloadCallDrift = (
  appId: string,
  calls: readonly OntosRegisteredWorkloadCall[],
): readonly { readonly built: number; readonly call: string; readonly reviewed: number }[] => {
  const reviewed = countingCalls(
    Object.entries(REVIEWED_REGISTERED_WORKLOAD_CALLS).find(([caller]) => caller === appId)?.[1] ?? [],
  );
  const built = countingCalls(calls.map(canonicalRegisteredWorkloadCall));
  return EffectArray.sort(new Set([...reviewed.keys(), ...built.keys()]), Order.String)
    .map((call) => ({ built: built.get(call) ?? 0, call, reviewed: reviewed.get(call) ?? 0 }))
    .filter((entry) => entry.built !== entry.reviewed);
};

/**
 * The drift of every contract in the checked workspace, one issue per declaration; the module contract check fails
 * on any. A reviewed caller the workspace does not hold is not judged here: a fixture workspace holds few modules,
 * and the generation test pins that the reviewed callers are exactly the modules that declare calls.
 */
export const registeredWorkloadCallInventoryIssues = (
  contracts: readonly {
    readonly deployment: { readonly appId: string };
    readonly manifest: { readonly registeredWorkloadCalls?: readonly OntosRegisteredWorkloadCall[] };
  }[],
): readonly string[] =>
  EffectArray.sort(
    contracts.map(({ deployment }) => deployment.appId),
    Order.String,
  ).flatMap((appId) =>
    registeredWorkloadCallDrift(
      appId,
      contracts.find(({ deployment }) => deployment.appId === appId)?.manifest.registeredWorkloadCalls ?? [],
    ).map(({ built, call, reviewed }) =>
      built > reviewed
        ? `${appId} declares a registered-workload call the reviewed inventory does not: ${call}`
        : `${appId} lacks a reviewed registered-workload call: ${call}`,
    ),
  );
