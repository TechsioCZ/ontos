import { Schema } from 'effect';

/**
 * The scope the source claims in its payload is not the trusted scope of the operation (Tenant or Legal Entity). The
 * request is refused whole: nothing is stored and nothing is decided, because a payload can never choose its scope.
 */
const scopeMismatchFields = {
  code: Schema.Literal('communication_request_scope_mismatch'),
  reason: Schema.String,
};
const scopeMismatchContract = Schema.TaggedStruct('CommunicationRequestScopeMismatch', scopeMismatchFields);
export const CommunicationRequestScopeMismatch = Schema.TaggedError<typeof scopeMismatchContract.Type>()(
  'CommunicationRequestScopeMismatch',
  scopeMismatchFields,
);

/**
 * The module that called the Action, as Core verified it, is not the source module the request claims. `source.moduleKey`
 * is only a claim until it is bound to the caller: one source can never issue a request in another source's name.
 * The request is refused whole: nothing is stored, decided or queued.
 */
const sourceMismatchFields = {
  code: Schema.Literal('communication_request_source_mismatch'),
  reason: Schema.String,
};
const sourceMismatchContract = Schema.TaggedStruct('CommunicationRequestSourceMismatch', sourceMismatchFields);
export const CommunicationRequestSourceMismatch = Schema.TaggedError<typeof sourceMismatchContract.Type>()(
  'CommunicationRequestSourceMismatch',
  sourceMismatchFields,
);

/**
 * A fact the decision needs could not be established right now: the source owner's current occurrence facts, the
 * approved template revisions or an owner store. Nothing is stored, so the source retries the same request and later
 * gets exactly one decision. It never means "no message": the request is simply not decided yet.
 */
const decisionUnavailableFields = {
  cause: Schema.optionalKey(Schema.Unknown),
  code: Schema.Literal('communication_decision_unavailable'),
  reason: Schema.String,
};
const decisionUnavailableContract = Schema.TaggedStruct('CommunicationDecisionUnavailable', decisionUnavailableFields);
export const CommunicationDecisionUnavailable = Schema.TaggedError<typeof decisionUnavailableContract.Type>()(
  'CommunicationDecisionUnavailable',
  decisionUnavailableFields,
);
