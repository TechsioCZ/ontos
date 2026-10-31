import { EmailDeliveryService } from '@app/email-delivery/server';
import { Effect, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { localEmailDeliveryLive } from '../support/local-email-delivery.ts';

it.effect('captures a real Resend submission at request execution time', () =>
  Effect.gen(function* localDelivery() {
    const requests: Request[] = [];
    const receipt = yield* Effect.gen(function* sendMessage() {
      const delivery = yield* EmailDeliveryService;
      return yield* delivery.send({
        subject: 'Verify your OntOS Commerce email address',
        text: Redacted.make('https://portal.example.test/verify-email?token=test-token'),
        to: 'recipient@example.test',
      });
    }).pipe(Effect.provide(localEmailDeliveryLive(requests)));
    expect(receipt).toEqual({ accepted: true, id: 'accepted' });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    if (request === undefined) {
      return yield* Effect.die('Missing local delivery request');
    }
    expect(request.url).toBe('https://api.resend.com/emails');
    expect(yield* Effect.promise(() => request.json())).toMatchObject({
      subject: 'Verify your OntOS Commerce email address',
      to: ['recipient@example.test'],
    });
    return yield* Effect.void;
  }),
);
