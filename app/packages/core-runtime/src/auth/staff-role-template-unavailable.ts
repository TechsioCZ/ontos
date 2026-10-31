import { ReadHandlerUnavailable } from '../reads/errors.ts';

export const staffRoleTemplateUnavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Staff role templates are temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );
