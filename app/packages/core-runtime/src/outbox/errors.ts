export { OutboxClaimLostError } from './outbox-claim-lost-error.ts';
export { OutboxHandlerExecutionError } from './outbox-handler-execution-error.ts';
export { OutboxPayloadDecodeError } from './outbox-payload-decode-error.ts';
export { OutboxPollerConfigError } from './outbox-poller-config-error.ts';
export { OutboxWorkerDescriptorError } from './outbox-worker-descriptor-error.ts';

export const sanitizeOutboxErrorMessage = (message: string): string =>
  message
    .replaceAll(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, 500) || 'Outbox Worker processing failed';
