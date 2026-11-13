import { Context, Option } from 'effect';

/**
 * The company of the Outbox message a worker is handling, as Core recorded it on the message's domain event
 * (`core.domain_events.legal_entity_id`, written from the acting scope in the publisher's transaction). The Outbox
 * runtime provides it around each handler; outside a handler, and for a message Core recorded without a company, it is
 * none.
 *
 * A delegated call for asynchronous work (`Originator`) carries it to the Shell, which binds the issued context to
 * exactly that company once it has checked Core's own record. A worker never sets it itself.
 */
export const OutboxMessageCompany = Context.Reference<Option.Option<string>>(
  '@app/core-runtime/outbox/message-company/OutboxMessageCompany',
  { defaultValue: () => Option.none<string>() },
);
