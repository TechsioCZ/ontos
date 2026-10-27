import { describe, expect, it } from 'effect-rstest';
import { Redacted } from 'effect';
import { isDispatchAuthorized, parseDeliveryQuery } from '../../api/email/transport.ts';

const query = (parameters: string) => parseDeliveryQuery(new URL(`https://shell.test/email/deliveries?${parameters}`));

describe('email endpoint policy', () => {
  it('accepts staff selectors, but not missing, unbounded, or unknown selectors', () => {
    expect(query('source=rent-reminder&subjectId=reminder-1')?.source).toBe('rent-reminder');
    expect(query('source=rent-reminder')).toBeNull();
    expect(query('source=unknown&subjectId=x')).toBeNull();
    expect(query('source=rent-reminder&subjectId=')).toBeNull();
    const selectors = Array.from({ length: 201 }, (_, index) => `subjectId=${index}`).join('&');
    expect(query(`source=rent-reminder&${selectors}`)).toBeNull();
  });
  it('allows buyer access only for one order number plus the checkout recipient', () => {
    expect(query('source=akros-order&subjectNumber=OBJ-1&recipient=buyer%40real.dev')?.recipient).toBe(
      'buyer@real.dev',
    );
    expect(query('source=akros-order&subjectId=private-id&recipient=buyer%40real.dev')).toBeNull();
    expect(query('source=akros-order&subjectNumber=OBJ-1&subjectNumber=OBJ-2&recipient=buyer%40real.dev')).toBeNull();
    expect(query('source=rent-reminder&subjectNumber=INV-1&recipient=buyer%40real.dev')).toBeNull();
    expect(query('source=facility-agenda&subjectNumber=person&recipient=buyer%40real.dev')).toBeNull();
    expect(query('source=akros-order&subjectNumber=OBJ-1&recipient=not-email')).toBeNull();
  });
  it('fails closed for an absent, empty, or wrong dispatch secret and accepts only the bearer header', () => {
    const headers = new Headers({ authorization: 'Bearer fixture-secret' });
    const configuration = new Map([
      ['configured', Redacted.make('fixture-secret')],
      ['different', Redacted.make('different')],
      ['empty', Redacted.make('')],
      ['whitespace', Redacted.make('   ')],
    ]);
    expect(isDispatchAuthorized(headers, configuration.get('missing'))).toBe(false);
    expect(isDispatchAuthorized(headers, configuration.get('empty'))).toBe(false);
    expect(isDispatchAuthorized(headers, configuration.get('whitespace'))).toBe(false);
    expect(isDispatchAuthorized(headers, configuration.get('different'))).toBe(false);
    expect(isDispatchAuthorized(new Headers(), configuration.get('configured'))).toBe(false);
    expect(isDispatchAuthorized(headers, configuration.get('configured'))).toBe(true);
    expect(
      isDispatchAuthorized(new Headers({ authorization: 'fixture-secret' }), configuration.get('configured')),
    ).toBe(false);
  });
});
