import {
  HandoffIndeterminateSchema,
  HandoffMessageInvalidSchema,
  HandoffRejectedSchema,
  HandoffUnavailableSchema,
} from '@app/communications-contracts/message-handoff';
import type {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryRejected,
  EmailDeliveryUnavailable,
} from '@app/email-delivery/server';
import { describe, expect, it } from 'effect-rstest';

/**
 * The published handoff contract is schema-only and cannot depend on `@app/email-delivery`, so it restates the closed reason
 * literals of the provider seam. These records are exhaustive over that seam's own types: a literal added or removed there fails
 * to compile here, and the test then proves the contract lists exactly the same ones.
 */
const indeterminate = {
  response_invalid: true,
  timeout: true,
  transport: true,
} satisfies Record<EmailDeliveryAcceptanceIndeterminate['reason'], true>;
const rejected = { provider_rejected: true, rate_limited: true } satisfies Record<
  EmailDeliveryRejected['reason'],
  true
>;
const unavailable = {
  configuration: true,
  provider_unavailable: true,
} satisfies Record<EmailDeliveryUnavailable['reason'], true>;
const invalidReason = {
  control_character: true,
  empty: true,
  invalid_format: true,
  too_long: true,
} satisfies Record<EmailDeliveryInvalidMessage['reason'], true>;
const invalidField = {
  from: true,
  html: true,
  idempotencyKey: true,
  subject: true,
  text: true,
  to: true,
} satisfies Record<EmailDeliveryInvalidMessage['field'], true>;

const sorted = (values: readonly string[]) => values.toSorted();

describe('the handoff contract and the provider seam name the same closed reasons', () => {
  it('lists exactly the reasons of every provider answer', () => {
    expect(sorted(HandoffIndeterminateSchema.fields.reason.literals)).toEqual(sorted(Object.keys(indeterminate)));
    expect(sorted(HandoffRejectedSchema.fields.reason.literals)).toEqual(sorted(Object.keys(rejected)));
    expect(sorted(HandoffUnavailableSchema.fields.reason.literals)).toEqual(sorted(Object.keys(unavailable)));
  });

  it('lists exactly the field and reason of an invalid message', () => {
    expect(sorted(HandoffMessageInvalidSchema.fields.reason.literals)).toEqual(sorted(Object.keys(invalidReason)));
    expect(sorted(HandoffMessageInvalidSchema.fields.field.literals)).toEqual(sorted(Object.keys(invalidField)));
  });
});
