import { ReadHandlerUnavailable } from '../reads/errors.ts';

export const agentActivityUnavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Agent activity is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );
