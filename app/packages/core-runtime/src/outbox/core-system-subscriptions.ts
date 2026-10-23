import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { OutboxWorkerSubscription } from './definition.ts';
import { outboxProducerModuleKey, outboxTopic } from './core-modules-tenant-module-state-changed-v1.ts';

const consumerModuleKey = 'core.authorization';
const workerKey = 'core.authorization.reconcile-module-installation';

/** Core-owned lifecycle work is published with the matching authority, not a tenant module contract. */
export const coreModuleInstallationSubscription = Object.freeze({
  consumerModuleKey,
  entrypoint: defineSystemModuleEntrypoint({
    access: 'background',
    authorization: { kind: 'owner_local_background' },
    entrypointKey: workerKey,
    moduleKey: consumerModuleKey,
    role: 'worker',
  }),
  producerModuleKey: outboxProducerModuleKey,
  topic: outboxTopic,
  workerKey,
});

const principalWorkerKey = 'core.authorization.reconcile-principal-lifecycle';
export const corePrincipalLifecycleSubscription = Object.freeze({
  consumerModuleKey,
  entrypoint: defineSystemModuleEntrypoint({
    access: 'background',
    authorization: { kind: 'owner_local_background' },
    entrypointKey: principalWorkerKey,
    moduleKey: consumerModuleKey,
    role: 'worker',
  }),
  producerModuleKey: 'core.identity',
  topic: 'core.identity.principal-lifecycle-changed.v1',
  workerKey: principalWorkerKey,
});
const bindingWorkerKey = 'core.authorization.reconcile-principal-binding';
export const corePrincipalBindingSubscription = Object.freeze({
  consumerModuleKey,
  entrypoint: defineSystemModuleEntrypoint({
    access: 'background',
    authorization: { kind: 'owner_local_background' },
    entrypointKey: bindingWorkerKey,
    moduleKey: consumerModuleKey,
    role: 'worker',
  }),
  producerModuleKey: 'core.identity',
  topic: 'core.identity.principal-binding-activated.v1',
  workerKey: bindingWorkerKey,
});

export const CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS: readonly OutboxWorkerSubscription[] = Object.freeze([
  coreModuleInstallationSubscription,
  corePrincipalBindingSubscription,
  corePrincipalLifecycleSubscription,
]);
