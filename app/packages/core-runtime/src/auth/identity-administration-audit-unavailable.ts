import { Data } from 'effect';

import { ReadHandlerUnavailable } from '../reads/errors.ts';

export const identityAdministrationAuditUnavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Identity administration audit is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

export class IdentityAdministrationDeniedAuditUnavailable extends Data.TaggedError(
  'IdentityAdministrationDeniedAuditUnavailable',
)<{
  readonly cause: unknown;
  readonly reason: string;
}> {}
