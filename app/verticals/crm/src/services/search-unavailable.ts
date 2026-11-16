import { ReadHandlerUnavailable } from '@app/core-runtime';

export const searchUnavailable = (cause?: unknown) => {
  const failure = new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'CRM search is temporarily unavailable',
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { value: cause });
};
