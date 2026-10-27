import { EmailDeliveryService } from '@app/email-delivery/server';
import type { EmailDeliveryError, EmailDeliveryMessage, EmailDeliveryReceipt } from '@app/email-delivery/server';
import { emailEnvironment, emailTransport } from '@app/email-delivery/transport';
import { Config, ConfigProvider, Effect, Layer, Option, Schema, String as EffectString } from 'effect';

/** Portal mail goes out as the deployment's own sender: `ONTOS_EMAIL_FROM` on a Worker, the SMTP sender on Node. */
const portalSenderSettings = Config.all({
  sender: Config.schema(Schema.Trim, 'ONTOS_EMAIL_FROM').pipe(Config.option),
  smtpSender: Config.schema(Schema.Trim, 'SMTP_FROM').pipe(Config.option),
}).pipe(
  Config.map(({ sender, smtpSender }) =>
    Option.match(Option.filter(EffectString.isNonEmpty)(sender), {
      onNone: () => Option.getOrElse(smtpSender, () => 'OntOS <oznameni@ontos.demo>'),
      onSome: (address) => `OntOS Commerce <${address}>`,
    }),
  ),
);

/**
 * The platform's installed email transport: the Cloudflare Email Service `EMAIL` binding on a Worker and SMTP
 * (Mailpit locally) on Node. One submission per message; an unconfigured transport answers unavailable.
 */
export type CommercePortalAuthPlatformEmailSubmit = (
  transport: Effect.Success<typeof emailTransport>,
  from: string,
  message: EmailDeliveryMessage,
) => Effect.Effect<EmailDeliveryReceipt, EmailDeliveryError>;

export const CommercePortalAuthPlatformEmailDeliveryLive = (submit: CommercePortalAuthPlatformEmailSubmit) =>
  Layer.effect(
    EmailDeliveryService,
    Effect.gen(function* platformEmailDelivery() {
      const environment = yield* emailEnvironment;
      const transport = yield* emailTransport;
      const from = yield* portalSenderSettings.parse(
        ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }),
      );
      return {
        send: (message: EmailDeliveryMessage) => submit(transport, from, message),
      };
    }),
  );
