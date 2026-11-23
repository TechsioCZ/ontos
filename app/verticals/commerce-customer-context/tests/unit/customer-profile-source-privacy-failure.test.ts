import { ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';

import { CommerceSourceProcessingRejected } from '../../src/integrations/source-processing-rejected.ts';
import { customerProfileSourcePrivacyFailure } from '../../src/persistence/customer-profile-source-persistence.ts';

it('preserves an authoritative Privacy denial as a forbidden source Profile read', () => {
  const cause = new CommerceSourceProcessingRejected({ code: 'DENIED', reason: 'Private Privacy decision details' });
  const failure = customerProfileSourcePrivacyFailure(cause);

  expect(failure).toBeInstanceOf(ReadPermissionDenied);
  expect(failure).toMatchObject({ code: 'read_permission_denied' });
  expect(JSON.stringify(failure)).not.toContain(cause.reason);
});

it('keeps genuine Privacy unavailability unavailable instead of enabling minimal receipt recovery', () => {
  const cause = new CommerceSourceProcessingRejected({
    code: 'UNAVAILABLE',
    reason: 'Private upstream transport details',
  });
  const failure = customerProfileSourcePrivacyFailure(cause);

  expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
  expect(failure).toMatchObject({ code: 'read_handler_unavailable' });
  expect(failure.cause).toBe(cause);
  expect(JSON.stringify(failure)).not.toContain(cause.reason);
});

it('does not turn untyped, malformed, unrelated or nested failures into a Privacy denial', () => {
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
