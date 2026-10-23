import { EmailDeliveryService } from '@app/email-delivery/server';
import { emailEnvironment, emailTransport } from '@app/email-delivery/transport';
import { Layer } from 'effect';

/** Portal mail goes out as the deployment's own sender: `ONTOS_EMAIL_FROM` on a Worker, the SMTP sender on Node. */
const senderAddress = (): string => {
  const sender = emailEnvironment['ONTOS_EMAIL_FROM']?.trim();
  if (sender !== undefined && sender !== '') {
    return `OntOS Commerce <${sender}>`;
  }
  return emailEnvironment['SMTP_FROM']?.trim() ?? 'OntOS <oznameni@ontos.demo>';
};

/**
 * The platform's installed email transport: the Cloudflare Email Service `EMAIL` binding on a Worker and SMTP
 * (Mailpit locally) on Node. One submission per message; an unconfigured transport answers unavailable.
 */
export const CommercePortalAuthPlatformEmailDeliveryLive = Layer.sync(EmailDeliveryService, () => {
  const from = senderAddress();
  return { send: (message) => emailTransport.makeDelivery(from, message.to).send(message) };
});
