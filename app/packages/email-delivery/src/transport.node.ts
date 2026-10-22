import { isTestRecipient, testCaptureFromEnvironment } from './dispatcher/recipients.ts';
import { makeSmtpEmailDelivery, smtpConfigurationFromEnvironment } from './smtp.ts';
import type { EmailEnvironment, EmailTransportRuntime } from './transport-runtime.ts';

export const emailEnvironment: EmailEnvironment = process.env;
const smtp = smtpConfigurationFromEnvironment(emailEnvironment);
const configured =
  (emailEnvironment['EMAIL_PROVIDER'] ?? 'smtp').trim().toLowerCase() !== 'none' && smtp.host.trim() !== '';
const testCapture = testCaptureFromEnvironment(emailEnvironment);

export const emailTransport: EmailTransportRuntime = {
  kind: 'smtp',
  provider: configured
    ? { configured: true, label: `SMTP server ${smtp.host}:${smtp.port}${smtp.port === 1025 ? ' (Mailpit)' : ''}` }
    : { configured: false, label: null },
  makeDelivery: (from, recipient) =>
    makeSmtpEmailDelivery(
      testCapture !== null && isTestRecipient(recipient)
        ? {
            from,
            host: testCapture.host,
            port: testCapture.port,
            secure: false,
            ...(smtp.timeoutMs === undefined ? {} : { timeoutMs: smtp.timeoutMs }),
          }
        : { ...smtp, from },
    ),
};
