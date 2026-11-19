import type { TransactionalMessageType } from './message-type.ts';

/**
 * The explicit approved set of Transactional Message Types. It is deliberately empty: no production type is approved
 * by the foundation or the catalog lane. A type enters only through an approved owner activation (a later plan)
 * together with its source onboarding contract. Test fixtures live in the unit tests, never here.
 *
 * An invalid list is never replaced by an empty registry, which would silently drop every other approved type
 * (BR-05/AC-04): the production decision layer fails to build with MessageTypeRegistryInvalid, and a unit test builds
 * this exact list so CI fails too.
 */
export const approvedMessageTypes: readonly TransactionalMessageType[] = [];
