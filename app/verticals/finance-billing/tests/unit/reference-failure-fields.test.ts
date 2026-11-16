import { describe, expect, it } from 'effect-rstest';
import { referenceFailureFields } from '../../src/services/reference-validation.ts';

describe('reference failure warning fields', () => {
  it('names the step, the error tag, its code and fixed reason, and the tag of the failure it wraps', () => {
    expect(
      referenceFailureFields('partner_credential', {
        _tag: 'ActionPrincipalUnavailableError',
        reason: 'Action identity verification is unavailable',
      }),
    ).toEqual({
      causeTag: null,
      code: null,
      errorTag: 'ActionPrincipalUnavailableError',
      reason: 'Action identity verification is unavailable',
      status: null,
      step: 'partner_credential',
    });
    expect(
      referenceFailureFields(
        'partner_read',
        { _tag: 'SqlError', reason: { _tag: 'UnknownError', message: 'PgConnection: Query failed' } },
        { batchSize: 3 },
      ),
    ).toMatchObject({
      batchSize: 3,
      causeTag: 'UnknownError',
      errorTag: 'SqlError',
      reason: null,
      step: 'partner_read',
    });
    expect(
      referenceFailureFields('issuer_read', {
        _tag: 'CounterpartyIdentitiesForbiddenProblem',
        code: 'read_forbidden',
        status: 403,
      }),
    ).toMatchObject({ code: 'read_forbidden', errorTag: 'CounterpartyIdentitiesForbiddenProblem', status: 403 });
  });

  it('never carries a URL, an address, a long number or free text out of the failure', () => {
    const fields = referenceFailureFields('partner_read', {
      _tag: 'https://party.example.test/party-registry-api?token=abc',
      code: 'jana.novakova@example.test',
      reason: 'Partner 27082440 is unknown',
    });
    expect([fields.errorTag, fields.code, fields.reason]).toEqual([null, null, null]);
  });

  it('records a missing issuer name with whether Core withheld it or holds an empty one', () => {
    expect(referenceFailureFields('issuer_name', undefined, { legalName: 'absent' })).toEqual({
      causeTag: null,
      code: null,
      errorTag: null,
      legalName: 'absent',
      reason: null,
      status: null,
      step: 'issuer_name',
    });
  });
});
