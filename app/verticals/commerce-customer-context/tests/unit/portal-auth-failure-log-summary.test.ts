import { APIError } from 'better-auth';
import { expect, it } from 'effect-rstest';

import { failureLogSummary } from '../../api/portal-auth/problems-support.ts';

it('keeps only the allow-listed failure fields for the operator log', () => {
  const providerFailure = new APIError('INTERNAL_SERVER_ERROR', {
    code: 'COMMERCE_AUTH_PROVIDER_FAILURE',
    message: 'The Commerce portal authentication provider call failed',
  });
  Object.assign(providerFailure, { headers: new Headers({ 'set-cookie': 'session=secret' }) });

  const summary = failureLogSummary(providerFailure);

  expect(summary).toEqual({ failure: 'untagged', status: 'INTERNAL_SERVER_ERROR' });
  expect(JSON.stringify(summary)).not.toContain('secret');
  const ownerFailure = { _tag: 'OwnerUnavailable', operation: 'read', reason: 'owner timeout' } as const;
  expect(failureLogSummary(ownerFailure)).toEqual({
    failure: 'OwnerUnavailable',
    operation: 'read',
    reason: 'owner timeout',
  });
  expect(failureLogSummary('not an object')).toEqual({ failure: 'unrecognized' });
});
