import type { OutboxWorkerRegistration } from '@mvp2/core-runtime';

export const registrationMatchesTopic = (
  registration: OutboxWorkerRegistration<unknown>,
  topic: string,
): boolean => registration.descriptor.topics.includes(topic);

export const matchingRegistrationsForTopic = (
  registrations: readonly OutboxWorkerRegistration<unknown>[],
  topic: string,
): readonly OutboxWorkerRegistration<unknown>[] =>
  registrations.filter((registration) => registrationMatchesTopic(registration, topic));
