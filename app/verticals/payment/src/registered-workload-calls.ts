import type { OntosRegisteredWorkloadCallInput } from '@app/core-runtime';

const acceptPaymentObservation = 'payment.core.accept-payment-observation';
const observationAccept = 'payment.core.observation.accept';
const processProviderNotification = 'payment.core.process-provider-notification';
const recoverGatewayOperation = 'payment.core.recover-gateway-operation';
const sourceIngress = 'payment.source-ingress';

/**
 * The registered-workload calls this module's credential makes; its manifest declares them. Each entry is verbatim
 * from the rules in docs/architecture/DEPLOYMENT.md, "Payment evidence workers", and
 * apps/shell-super-app/tests/integration/payment-self-registered-workload-probe.test.ts. Payment's
 * notification and recovery Outbox Workers submit provider evidence through its own A8 Action; the Shell keeps an
 * entry only while the installed receiver declares its workload and declaration, and a tenant still needs an active
 * registration of `payment.source-ingress`.
 */
export const paymentRegisteredWorkloadCalls = [processProviderNotification, recoverGatewayOperation].map(
  (workerKey): OntosRegisteredWorkloadCallInput => ({
    audience: 'payment',
    declarationKey: observationAccept,
    entrypointKey: acceptPaymentObservation,
    jobKey: workerKey,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey,
    workloadKey: sourceIngress,
  }),
);
