// Blessed shape: an outbox/action descriptor literal that registers a genuinely opaque payload as
// `Schema.Json`. This is the exact "registered payload Schemas" pattern the audit preserves, and
// descriptor literals like this already exist at module scope throughout the repo, e.g.
//   verticals/contacts/src/actions/archive-contact.action.ts:95  `payloadSchema: ArchiveContactPayload`
//   packages/core-runtime/src/outbox/definition.ts:42            `readonly payloadSchema: PayloadSchema`
// The descriptor is an argument to `defineOutboxWorker`, not to a `Schema.*` combinator, so
// `insideSchemaCall` does not recognise the field position and the property is reported.
import { Schema } from 'effect';

declare const defineOutboxWorker: (descriptor: unknown) => unknown;

export const opaqueEvidenceWorker = defineOutboxWorker({
  consumerModuleKey: 'contacts.core',
  payloadSchema: Schema.Json,
  producerModuleKey: 'contacts.core',
  topic: 'contacts.evidence-archived',
});
