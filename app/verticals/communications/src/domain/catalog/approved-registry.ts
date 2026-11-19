import { Result } from 'effect';

import type { TransactionalMessageType } from './message-type.ts';
import { emptyMessageTypeRegistry, buildMessageTypeRegistry } from './registry.ts';

/**
 * The explicit approved set of Transactional Message Types. It is deliberately empty: no production type is approved
 * by the foundation or the catalog lane. A type enters only through an approved owner activation (a later plan)
 * together with its source onboarding contract. Test fixtures live in the unit tests, never here.
 */
export const approvedMessageTypes: readonly TransactionalMessageType[] = [];

/** An invalid approved list fails closed to the empty registry, which approves nothing. */
export const approvedMessageTypeRegistry = Result.getOrElse(
  buildMessageTypeRegistry(approvedMessageTypes),
  () => emptyMessageTypeRegistry,
);
