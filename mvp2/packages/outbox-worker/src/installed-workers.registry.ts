import type { OutboxWorkerRegistration } from '@mvp2/core-runtime';
import { propertiesUnitCreatedWorkerRegistration } from '../../../verticals/accounting/src/workers/properties-unit-created.registration.mts';

export type InstalledOutboxWorkerRegistration = OutboxWorkerRegistration<unknown>;

export type InstalledOutboxWorkerRegistry = {
  readonly registrations: readonly InstalledOutboxWorkerRegistration[];
};

export const installedOutboxWorkerRegistrations = [
  propertiesUnitCreatedWorkerRegistration,
] satisfies readonly InstalledOutboxWorkerRegistration[];

export const installedOutboxWorkerRegistry = {
  registrations: installedOutboxWorkerRegistrations,
} satisfies InstalledOutboxWorkerRegistry;
