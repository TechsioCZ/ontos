import { accountingOutboxWorkerRegistrations } from '@mvp2/accounting/outbox-workers';
import type { OutboxWorkerRegistration } from '@mvp2/core-runtime/outbox';

export type InstalledOutboxWorkerRegistration = OutboxWorkerRegistration<unknown>;

export const installedOutboxWorkerRegistrations = [
  ...accountingOutboxWorkerRegistrations,
] satisfies readonly InstalledOutboxWorkerRegistration[];
