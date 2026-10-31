import { ResendEmailDeliveryConfig, ResendEmailDeliveryLive } from '@app/email-delivery/resend';
import { EmailDeliveryService } from '@app/email-delivery/server';
import { Effect, Layer, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';

/** Capture real provider submissions without contacting Resend. */
export const localEmailDeliveryLive = (requests: Request[]) => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== 'https://api.resend.com/emails') {
      throw new Error('Unexpected local email delivery endpoint');
    }
    requests.push(request);
    return Response.json({ id: 'accepted' });
  };
  const resendLive = ResendEmailDeliveryLive.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(ResendEmailDeliveryConfig, {
        apiKey: Redacted.make('re_commerce_enrollment_counterparty_invitation'),
        endpoint: 'https://api.resend.com/emails',
        from: 'no-reply@commerce.example.test',
      }),
    ),
  );
  // Fetch is a fiber reference read when a request executes, not when its layer is built.
  return Layer.effect(
    EmailDeliveryService,
    Effect.gen(function* localEmailDelivery() {
      const resend = yield* EmailDeliveryService;
      return { send: (message) => resend.send(message).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)) };
    }),
  ).pipe(Layer.provide(resendLive));
};
