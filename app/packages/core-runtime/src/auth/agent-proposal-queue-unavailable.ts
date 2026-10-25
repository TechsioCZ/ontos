import { ReadHandlerUnavailable, ReadPermissionDenied } from '../reads/errors.ts';

export const agentProposalQueueUnavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Agent proposals are temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

export const agentProposalQueueDenied = () =>
  new ReadPermissionDenied({
    code: 'read_permission_denied',
    reason: 'The principal cannot read these agent proposals',
  });
