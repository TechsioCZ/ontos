import { Schema } from 'effect';
import { Schema as Codec } from 'effect';
import * as Contract from 'effect/Schema';
import { HttpApiSchema } from '@modern-js/plugin-bff/effect-edge';

// The audit-blessed shape: the problem is declared once, and the status belongs to the contract.
const asProblemDetails = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export const ContactsUnavailableProblemSchema = Schema.TaggedStruct('ContactsUnavailableProblem', {
  detail: Schema.String,
  retryable: Schema.Literal(true),
  status: Schema.Finite,
  title: Schema.String,
  type: Schema.String,
}).pipe(asProblemDetails, HttpApiSchema.status(503));

export class ContactsInternalProblem extends Schema.TaggedError<ContactsInternalProblem>()(
  'ContactsInternalProblem',
  { detail: Schema.String },
  HttpApiSchema.annotations({ status: 500, title: 'Contacts operation failed' }),
) {}

// Aliased and namespace-imported Schema bindings must be recognised exactly like the plain names.
export const aliased = Codec.annotations({
  status: 503,
  title: 'Contacts unavailable',
  type: 'https://ontos.dev/problems/contacts-unavailable',
});

export const namespaced = Contract.annotations({
  status: 404,
  title: 'Contacts record not found',
  type: 'https://ontos.dev/problems/contacts-not-found',
});

// A4: actual Schema ownership is required; a Schema-suffixed name is not evidence.
const ProblemDetailsSchema = Schema.annotations;
export const declared = ProblemDetailsSchema({
  status: 428,
  title: 'Idempotency key required',
  type: 'https://ontos.dev/problems/idempotency-key-required',
});
