import type { EmailMessage, EmailMessageBuilder } from '@cloudflare/workers-types';
import { NodeCrypto } from '@effect/platform-node';
import { Context, Effect, Fiber, Layer, Redacted, Result, Schema } from 'effect';
import { flow } from 'effect/Function';
import { TestClock } from 'effect/testing';
import { describe, expect, it, rs } from 'effect-rstest';
import { CloudflareEmailDeliveryLive } from '../../src/cloudflare.ts';
import type { CloudflareEmailBinding } from '../../src/cloudflare.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryService,
  EmailDeliveryUnavailable,
} from '../../src/server.ts';
import type { EmailDeliveryServiceContract } from '../../src/server.ts';
import { submitEmail } from '../../src/dispatcher/dispatch.ts';
import type { PlannedEmail } from '../../src/dispatcher/contract.ts';
import { AKROS_LEGAL_ENTITY_ID, SIAMPARK_LEGAL_ENTITY_ID } from '../../src/dispatcher/contract.ts';
import { isUndeliverableRecipient } from '../../src/dispatcher/recipients.ts';
import { agendaSenderFor, senderFor } from '../../src/dispatcher/senders.ts';

type BindingRequest = EmailMessage | EmailMessageBuilder;
type BindingReceipt = Awaited<ReturnType<CloudflareEmailBinding['send']>>;
const from = 'AKROS e-shop <noreply@ontos-stage.techsio.cz>';
const message = {
  html: Redacted.make('<p>Text</p>'),
  subject: 'Objednávka',
  text: Redacted.make('Text'),
  to: 'customer@techsio.cz',
};
const planned: PlannedEmail & { readonly from: string } = {
  dedupeKey: 'order:1',
  event: 'ORDER_CREATED',
  eventAt: '2026-10-21T12:00:00Z',
  eventLabel: 'Přijetí objednávky',
  from,
  html: '<p>Text</p>',
  legalEntityId: AKROS_LEGAL_ENTITY_ID,
  recipient: message.to,
  source: 'akros-order',
  subject: message.subject,
  subjectId: 'order1',
  subjectNumber: 'OBJ-1',
  tenantId: 'tenant1',
  text: 'Text',
};

const requests: BindingRequest[] = [];
it.layer(
  CloudflareEmailDeliveryLive(
    {
      send: flow(
        (request: BindingRequest) => {
          requests.push(request);
        },
        rs.fn<() => Promise<BindingReceipt>>().mockResolvedValue({ messageId: 'cf-123' }),
      ),
    },
    from,
  ),
)((test) => {
  test.effect('submits exactly the Email Service payload and maps its messageId', () =>
    Effect.gen(function* bindingPayload() {
      const service = yield* EmailDeliveryService;
      expect(yield* service.send(message)).toEqual({ accepted: true, id: 'cf-123' });
      expect(requests).toEqual([{ from, html: '<p>Text</p>', subject: message.subject, text: 'Text', to: message.to }]);
    }),
  );
});

// The foreign Workers SDK returns a Promise. Leave its receipt pending to exercise the native timeout boundary.
const pendingReceipt = Promise.withResolvers<BindingReceipt>();
const pendingSubmission = rs.fn<() => Promise<BindingReceipt>>().mockReturnValue(pendingReceipt.promise);
it.layer(CloudflareEmailDeliveryLive({ send: pendingSubmission }, from))((test) => {
  test.effect('times out an uncertain SDK submission without retrying or claiming acceptance', () =>
    Effect.gen(function* uncertainSubmission() {
      const service = yield* EmailDeliveryService;
      const submission = yield* service.send(message).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust('10 seconds');
      const result = yield* Fiber.join(submission);
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result) || !Schema.is(EmailDeliveryAcceptanceIndeterminate)(result.failure)) {
        expect.unreachable('A pending provider submission must time out indeterminate');
      }
      expect(result.failure.reason).toBe('timeout');
      expect(pendingSubmission).toHaveBeenCalledTimes(1);
      pendingReceipt.resolve({ messageId: 'late-acceptance' });
    }),
  );
});

let failingCalls = 0;
it.layer(
  CloudflareEmailDeliveryLive(
    {
      send: flow(
        () => {
          failingCalls += 1;
        },
        rs.fn<() => Promise<BindingReceipt>>().mockRejectedValue(new Error('private provider diagnostics')),
      ),
    },
    from,
  ),
)((test) => {
  test.effect('does not claim success or retry when the binding throws', () =>
    Effect.gen(function* bindingFailure() {
      const service = yield* EmailDeliveryService;
      const error = yield* Effect.flip(service.send(message));
      expect(Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)).toBe(true);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error);
      expect(encoded).not.toContain('private provider diagnostics');
      expect(failingCalls).toBe(1);
    }),
  );
});

it.layer(
  CloudflareEmailDeliveryLive(
    {
      send: rs.fn<() => Promise<BindingReceipt>>().mockResolvedValue({ messageId: '' }),
    },
    from,
  ),
)((test) => {
  test.effect('treats a malformed receipt as ambiguous, never as acceptance', () =>
    Effect.gen(function* malformedReceipt() {
      const service = yield* EmailDeliveryService;
      const error = yield* Effect.flip(service.send(message));
      expect(Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)).toBe(true);
    }),
  );
});

class MissingBindingDelivery extends Context.Service<MissingBindingDelivery, EmailDeliveryServiceContract>()(
  '@app/email-delivery/tests/unit/cloudflare.test/MissingBindingDelivery',
) {}
const missingBindingLayer = Layer.effect(MissingBindingDelivery, EmailDeliveryService).pipe(
  Layer.provide(CloudflareEmailDeliveryLive(undefined, from)),
);
let invalidCalls = 0;
it.layer(
  Layer.merge(
    missingBindingLayer,
    CloudflareEmailDeliveryLive(
      {
        send: flow(
          () => {
            invalidCalls += 1;
          },
          rs.fn<() => Promise<BindingReceipt>>().mockResolvedValue({ messageId: 'unexpected' }),
        ),
      },
      from,
    ),
  ),
)((test) => {
  test.effect('fails before submission for a missing binding or header injection', () =>
    Effect.gen(function* preflightValidation() {
      const unavailableService = yield* MissingBindingDelivery;
      const unavailable = yield* Effect.flip(unavailableService.send(message));
      expect(Schema.is(EmailDeliveryUnavailable)(unavailable)).toBe(true);
      const service = yield* EmailDeliveryService;
      const invalid = yield* Effect.flip(service.send({ ...message, subject: 'bad\r\nSubject' }));
      expect(Schema.is(EmailDeliveryInvalidMessage)(invalid)).toBe(true);
      expect(invalidCalls).toBe(0);
    }),
  );
});

const assertRuntimeDelivery = Effect.fn('EmailDeliveryTest.runtime')(function* assertRuntimeDelivery([
  kind,
  recipient,
]: readonly [Parameters<typeof submitEmail>[1]['kind'], string]) {
  let calls = 0;
  const outcome = yield* submitEmail(
    { ...planned, recipient },
    {
      deliveryLayer: () =>
        Layer.succeed(EmailDeliveryService, {
          send: () => {
            calls += 1;
            return Effect.succeed({ accepted: true, id: 'accepted' });
          },
        }),
      kind,
      provider: { configured: true, label: kind },
    },
    {},
  );
  expect(outcome).toEqual({ messageId: 'accepted', status: 'SENT' });
  expect(calls).toBe(1);
});

const submitsToSelectedRuntime = () =>
  Effect.forEach(
    [
      ['smtp', 'person@example.com'],
      ['cloudflare', message.to],
    ] as const,
    assertRuntimeDelivery,
    { concurrency: 1 },
  );

describe('undeliverable recipients', () => {
  it.layer(NodeCrypto.layer)((test) => {
    for (const domain of [
      'demo.ontos',
      'najempark.demo',
      'hanak.demo',
      'akros.demo',
      'kavarna.demo',
      'nested.demo.ontos',
      'a.test',
      'a.invalid',
      'a.example',
      'a.local',
      'example.com',
    ]) {
      test.effect(`skips ${domain} without constructing or calling a transport`, () =>
        Effect.gen(function* skipFakeDomain() {
          const outcome = yield* submitEmail(
            { ...planned, recipient: `person@${domain}` },
            {
              deliveryLayer: () => {
                throw new Error('must not submit fake recipients');
              },
              kind: 'cloudflare',
              provider: { configured: true, label: 'Cloudflare' },
            },
            {},
          );
          expect(outcome).toEqual({ errorTag: 'undeliverable_recipient', status: 'SKIPPED' });
        }),
      );
    }
    test.effect('skips seeded fake recipients on the local SMTP transport too', () =>
      Effect.gen(function* skipFakeSmtp() {
        const outcome = yield* submitEmail(
          { ...planned, recipient: 'person@demo.ontos' },
          {
            deliveryLayer: () => {
              throw new Error('must not submit fake recipients');
            },
            kind: 'smtp',
            provider: { configured: true, label: 'Mailpit' },
          },
          {},
        );
        expect(outcome).toEqual({ errorTag: 'undeliverable_recipient', status: 'SKIPPED' });
      }),
    );
    it('normalizes suffixes without matching lookalike real domains or local-part test markers', () => {
      expect(isUndeliverableRecipient('PERSON@AKROS.DEMO')).toBe(true);
      expect(isUndeliverableRecipient('tester@notdemo.cz')).toBe(false);
      expect(isUndeliverableRecipient('person@demo.ontos.attacker.dev')).toBe(false);
      expect(isUndeliverableRecipient('real@extra.company', '.extra.company')).toBe(true);
      expect(isUndeliverableRecipient('real@techsio.cz', '.extra.company')).toBe(false);
    });
    test.effect(
      'sends documentation-domain recipients to the local SMTP capture, and real stage recipients to the binding',
      submitsToSelectedRuntime,
    );
  });
});

it.effect('uses the single onboarded stage address even when company SMTP overrides exist', () =>
  Effect.gen(function* stageSender() {
    const env = {
      AKROS_EMAIL_FROM: 'eshop@akros.demo',
      ONTOS_EMAIL_FROM: 'noreply@ontos-stage.techsio.cz',
      SIAMPARK_AGENDA_EMAIL_FROM: 'provoz@najempark.demo',
      SIAMPARK_EMAIL_FROM: 'finance@najempark.demo',
    };
    expect(yield* senderFor({ legalEntityId: AKROS_LEGAL_ENTITY_ID }, 'AKROS', env, 'cloudflare')).toBe(from);
    expect(yield* senderFor({ legalEntityId: SIAMPARK_LEGAL_ENTITY_ID }, 'Nájempark', env, 'cloudflare')).toBe(
      'Nájempark – finanční oddělení <noreply@ontos-stage.techsio.cz>',
    );
    expect(
      yield* agendaSenderFor({ legalEntityId: SIAMPARK_LEGAL_ENTITY_ID, legalName: 'Nájempark' }, env, 'cloudflare'),
    ).toBe('Nájempark – upozornění <noreply@ontos-stage.techsio.cz>');
    expect(yield* senderFor({ legalEntityId: AKROS_LEGAL_ENTITY_ID }, 'AKROS', env, 'smtp')).toBe('eshop@akros.demo');
    expect(yield* senderFor({ legalEntityId: SIAMPARK_LEGAL_ENTITY_ID }, 'Nájempark', env, 'smtp')).toBe(
      'finance@najempark.demo',
    );
  }),
);

const brandedSubmission = rs.fn<(request: BindingRequest) => Promise<BindingReceipt>>().mockResolvedValue({
  messageId: 'cf-najempark',
});
it.layer(
  Layer.unwrap(
    Effect.map(
      senderFor(
        { legalEntityId: SIAMPARK_LEGAL_ENTITY_ID },
        'Nájempark',
        { ONTOS_EMAIL_FROM: 'noreply@ontos.example' },
        'cloudflare',
      ),
      (sender) => CloudflareEmailDeliveryLive({ send: brandedSubmission }, sender),
    ),
  ),
)((test) => {
  test.effect('submits the Nájempark sender name to the mocked Cloudflare binding', () =>
    Effect.gen(function* brandedBindingPayload() {
      const service = yield* EmailDeliveryService;
      expect(yield* service.send({ ...message, to: 'customer@example.test' })).toEqual({
        accepted: true,
        id: 'cf-najempark',
      });
      expect(brandedSubmission).toHaveBeenCalledTimes(1);
      expect(brandedSubmission.mock.calls[0]?.[0]).toEqual({
        from: 'Nájempark – finanční oddělení <noreply@ontos.example>',
        html: '<p>Text</p>',
        subject: message.subject,
        text: 'Text',
        to: 'customer@example.test',
      });
    }),
  );
});
