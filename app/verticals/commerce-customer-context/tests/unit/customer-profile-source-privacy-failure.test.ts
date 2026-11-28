import { ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommerceSourceProcessingRejected } from '../../src/integrations/source-processing-rejected.ts';
import {
  CustomerProfileSourceRefused,
  customerProfileSourceCurrentResult,
  customerProfileSourcePersonFallbackFailure,
  customerProfileSourcePrivacyFailure,
} from '../../src/persistence/customer-profile-source-persistence.ts';

const isRefused = Schema.is(Schema.TaggedStruct('REFUSED', {}));
const isCurrent = Schema.is(Schema.TaggedStruct('CURRENT', { item: Schema.Struct({ profile: Schema.String }) }));
const denied = new CommerceSourceProcessingRejected({ code: 'DENIED', reason: 'Private Privacy decision details' });
const outage = new CommerceSourceProcessingRejected({
  code: 'UNAVAILABLE',
  reason: 'Private upstream transport details',
});

it('keeps an authoritative Privacy denial of the exact source as a refusal that carries none of the decision', () => {
  const failure = customerProfileSourcePrivacyFailure(denied);

  expect(failure).toBeInstanceOf(CustomerProfileSourceRefused);
  expect(JSON.stringify(failure)).not.toContain(denied.reason);
});

it('keeps genuine Privacy unavailability unavailable', () => {
  const failure = customerProfileSourcePrivacyFailure(outage);

  expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
  expect(failure).toMatchObject({ code: 'read_handler_unavailable' });
  expect(failure.cause).toBe(outage);
  expect(JSON.stringify(failure)).not.toContain(outage.reason);
});

it('does not turn untyped, malformed, unrelated or nested failures into a Privacy refusal', () => {
  for (const cause of [
    undefined,
    null,
    'DENIED',
    new Error('DENIED'),
    { code: 'DENIED', reason: 'An unrelated error code is not an authoritative Privacy refusal' },
    { _tag: 'AnotherOwnerRejected', code: 'DENIED', reason: 'Another owner refused' },
    { _tag: 'CommerceSourceProcessingRejected', code: 'DENIED' },
    { _tag: 'CommerceSourceProcessingRejected', code: 'UNKNOWN', reason: 'Unknown Privacy outcome' },
    { cause: new CommerceSourceProcessingRejected({ code: 'DENIED', reason: 'A nested refusal is not this failure' }) },
  ]) {
    const failure = customerProfileSourcePrivacyFailure(cause);
    expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
    expect(failure).toMatchObject({ code: 'read_handler_unavailable' });
    expect(failure.cause).toBe(cause);
  }
});

it.effect('answers a refused current item as REFUSED and every other failure as the failure it is', () =>
  Effect.gen(function* currentResult() {
    expect(isCurrent(yield* customerProfileSourceCurrentResult(Effect.succeed({ profile: 'current' })))).toBe(true);
    expect(
      isRefused(yield* customerProfileSourceCurrentResult(Effect.fail(customerProfileSourcePrivacyFailure(denied)))),
    ).toBe(true);
    const unavailable = yield* customerProfileSourceCurrentResult(
      Effect.fail(customerProfileSourcePrivacyFailure(outage)),
    ).pipe(Effect.flip);
    expect(unavailable).toBeInstanceOf(ReadHandlerUnavailable);
  }),
);

it.effect('keeps the refusal of a Counterparty read as its person, and wraps every other fallback failure', () =>
  Effect.gen(function* personFallback() {
    // The Counterparty holds no organization authority, so the current read falls back to its person.
    const organization = new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Current source Profile evidence is unavailable',
    });
    const fallback = (person: CommerceSourceProcessingRejected) =>
      customerProfileSourceCurrentResult(
        Effect.fail(customerProfileSourcePrivacyFailure(person)).pipe(
          Effect.mapError((failure) => customerProfileSourcePersonFallbackFailure(organization, failure)),
        ),
      );
    expect(isRefused(yield* fallback(denied))).toBe(true);
    const failure = yield* fallback(outage).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
    expect(failure.cause).toMatchObject({ organization });
    expect(JSON.stringify(failure)).not.toContain(outage.reason);
  }),
);
