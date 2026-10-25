// @effect-diagnostics *:off
import { describe, expect, it } from '@rstest/core';
import { Effect, Redacted, Schema } from 'effect';
import { makeCloudflareEmailDelivery } from '../../src/cloudflare.ts';
import {
  EmailDeliveryAcceptanceIndeterminate,
  EmailDeliveryInvalidMessage,
  EmailDeliveryUnavailable,
} from '../../src/server.ts';
import type { CloudflareEmailBinding } from '../../src/cloudflare.ts';
import { submitEmail } from '../../src/dispatcher/dispatch.ts';
import type { PlannedEmail } from '../../src/dispatcher/contract.ts';
import { AKROS_LEGAL_ENTITY_ID, SIAMPARK_LEGAL_ENTITY_ID } from '../../src/dispatcher/contract.ts';
import { isUndeliverableRecipient } from '../../src/dispatcher/recipients.ts';
import { agendaSenderFor, senderFor } from '../../src/dispatcher/senders.ts';

const from = 'AKROS e-shop <noreply@ontos-stage.bleeding.dev>';
const message = {
  to: 'customer@bleeding.dev',
  subject: 'Objednávka',
  text: Redacted.make('Text'),
  html: Redacted.make('<p>Text</p>'),
};
const planned: PlannedEmail & { readonly from: string } = {
  from,
  dedupeKey: 'order:1',
  event: 'ORDER_CREATED',
  eventAt: '2026-10-21T12:00:00Z',
  eventLabel: 'Přijetí objednávky',
  html: '<p>Text</p>',
  text: 'Text',
  recipient: message.to,
  subject: message.subject,
  source: 'akros-order',
  subjectId: 'order1',
  subjectNumber: 'OBJ-1',
  tenantId: 'tenant1',
  legalEntityId: AKROS_LEGAL_ENTITY_ID,
};

it('submits exactly the Email Service payload and maps its messageId', async () => {
  const requests: Parameters<CloudflareEmailBinding['send']>[0][] = [];
  const service = makeCloudflareEmailDelivery(
    {
      send: async (request) => {
        requests.push(request);
        return { messageId: 'cf-123' };
      },
    },
    from,
  );
  expect(await Effect.runPromise(service.send(message))).toEqual({ accepted: true, id: 'cf-123' });
  expect(requests).toEqual([{ from, to: message.to, subject: message.subject, text: 'Text', html: '<p>Text</p>' }]);
});

it('does not claim success or retry when the binding throws', async () => {
  let calls = 0;
  const service = makeCloudflareEmailDelivery(
    {
      send: async () => {
        calls++;
        throw new Error('private provider diagnostics');
      },
    },
    from,
  );
  const error = await Effect.runPromise(Effect.flip(service.send(message)));
  expect(Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)).toBe(true);
  expect(JSON.stringify(error)).not.toContain('private provider diagnostics');
  expect(calls).toBe(1);
});

it('treats a malformed receipt as ambiguous, never as acceptance', async () => {
  const service = makeCloudflareEmailDelivery({ send: async () => ({ messageId: '' }) }, from);
  const error = await Effect.runPromise(Effect.flip(service.send(message)));
  expect(Schema.is(EmailDeliveryAcceptanceIndeterminate)(error)).toBe(true);
});

it('fails before submission for a missing binding or header injection', async () => {
  const unavailable = await Effect.runPromise(Effect.flip(makeCloudflareEmailDelivery(undefined, from).send(message)));
  expect(Schema.is(EmailDeliveryUnavailable)(unavailable)).toBe(true);
  let calls = 0;
  const service = makeCloudflareEmailDelivery(
    {
      send: async () => {
        calls++;
        return { messageId: 'unexpected' };
      },
    },
    from,
  );
  const invalid = await Effect.runPromise(Effect.flip(service.send({ ...message, subject: 'bad\r\nSubject' })));
  expect(Schema.is(EmailDeliveryInvalidMessage)(invalid)).toBe(true);
  expect(calls).toBe(0);
});

describe('undeliverable recipients', () => {
  for (const domain of [
    'demo.ontos',
    'siampark.demo',
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
    it(`skips ${domain} without constructing or calling a transport`, async () => {
      const outcome = await Effect.runPromise(
        submitEmail(
          { ...planned, recipient: `person@${domain}` },
          {
            kind: 'cloudflare',
            provider: { configured: true, label: 'Cloudflare' },
            makeDelivery: () => {
              throw new Error('must not submit fake recipients');
            },
          },
          {},
        ),
      );
      expect(outcome).toEqual({ status: 'SKIPPED', errorTag: 'undeliverable_recipient' });
    });
  }
  it('skips seeded fake recipients on the local SMTP transport too', async () => {
    const outcome = await Effect.runPromise(
      submitEmail(
        { ...planned, recipient: 'person@demo.ontos' },
        {
          kind: 'smtp',
          provider: { configured: true, label: 'Mailpit' },
          makeDelivery: () => {
            throw new Error('must not submit fake recipients');
          },
        },
        {},
      ),
    );
    expect(outcome).toEqual({ status: 'SKIPPED', errorTag: 'undeliverable_recipient' });
  });
  it('normalizes suffixes without matching lookalike real domains or local-part test markers', () => {
    expect(isUndeliverableRecipient('PERSON@AKROS.DEMO')).toBe(true);
    expect(isUndeliverableRecipient('tester@notdemo.cz')).toBe(false);
    expect(isUndeliverableRecipient('person@demo.ontos.attacker.dev')).toBe(false);
    expect(isUndeliverableRecipient('real@extra.company', '.extra.company')).toBe(true);
    expect(isUndeliverableRecipient('real@bleeding.dev', '.extra.company')).toBe(false);
  });
  it('sends documentation-domain recipients to the local SMTP capture, and real stage recipients to the binding', async () => {
    for (const [kind, recipient] of [
      ['smtp', 'person@example.com'],
      ['cloudflare', message.to],
    ] as const) {
      let calls = 0;
      const outcome = await Effect.runPromise(
        submitEmail(
          { ...planned, recipient },
          {
            kind,
            provider: { configured: true, label: kind },
            makeDelivery: () => ({
              send: () => {
                calls++;
                return Effect.succeed({ accepted: true, id: 'accepted' });
              },
            }),
          },
          {},
        ),
      );
      expect(outcome).toEqual({ status: 'SENT', messageId: 'accepted' });
      expect(calls).toBe(1);
    }
  });
});

it('uses the single onboarded stage address even when company SMTP overrides exist', () => {
  const env = {
    ONTOS_EMAIL_FROM: 'noreply@ontos-stage.bleeding.dev',
    AKROS_EMAIL_FROM: 'eshop@akros.demo',
    SIAMPARK_AGENDA_EMAIL_FROM: 'provoz@siampark.demo',
  };
  expect(senderFor({ legalEntityId: AKROS_LEGAL_ENTITY_ID }, 'AKROS', env, 'cloudflare')).toBe(from);
  expect(agendaSenderFor({ legalEntityId: SIAMPARK_LEGAL_ENTITY_ID, legalName: 'Siampark' }, env, 'cloudflare')).toBe(
    'Siampark – upozornění <noreply@ontos-stage.bleeding.dev>',
  );
  expect(senderFor({ legalEntityId: AKROS_LEGAL_ENTITY_ID }, 'AKROS', env, 'smtp')).toBe('eshop@akros.demo');
});
