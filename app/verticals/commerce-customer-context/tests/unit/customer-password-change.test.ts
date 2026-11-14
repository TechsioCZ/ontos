import { APIError } from 'better-auth';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { classifyPasswordChangeFailure } from '../../api/portal-auth/password-change/routine.ts';
import { UpdateCustomerPasswordSchema } from '../../shared/portal-auth/password-change-api.ts';

const body = (currentPassword: string, newPassword: string) => ({ currentPassword, newPassword });
const current = 'current-value-1';
const fresh = 'fresh-value-1234';

it('maps only Better Auth verdicts to the wrong-current and invalid-new-password classes', () => {
  expect(classifyPasswordChangeFailure(new APIError('BAD_REQUEST', { code: 'INVALID_PASSWORD', message: 'x' }))).toBe(
    'current-invalid',
  );
  expect(classifyPasswordChangeFailure(new APIError('BAD_REQUEST', { code: 'PASSWORD_TOO_SHORT', message: 'x' }))).toBe(
    'invalid',
  );
  expect(classifyPasswordChangeFailure(new APIError('BAD_REQUEST', { code: 'PASSWORD_TOO_LONG', message: 'x' }))).toBe(
    'invalid',
  );
});

it('treats every other failure, including a transport error, as unavailable without a verdict', () => {
  expect(classifyPasswordChangeFailure(new APIError('INTERNAL_SERVER_ERROR', { message: 'x' }))).toBe('unavailable');
  expect(classifyPasswordChangeFailure(new Error('socket hang up'))).toBe('unavailable');
  expect(classifyPasswordChangeFailure(null)).toBe('unavailable');
});

it('decodes a closed body with a non-empty current password and a 12 to 128 character new password', () => {
  const decode = Schema.decodeUnknownSync(UpdateCustomerPasswordSchema, { onExcessProperty: 'error' });
  expect(decode(body(current, fresh))).toEqual(body(current, fresh));
  expect(() => decode(body(current, 'x'.repeat(11)))).toThrow();
  expect(() => decode(body('', fresh))).toThrow();
  expect(() => decode({ ...body(current, fresh), userId: 'not-declared' })).toThrow();
});
