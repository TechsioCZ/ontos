import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { describe, expect, it, test } from 'effect-rstest';
import type { PlannedEmail } from '../../src/dispatcher/contract.ts';
import { deliveryIdempotencyKey, scheduleScopes, submitEmail } from '../../src/dispatcher/dispatch.ts';
import { EmailDeliveryService } from '../../src/server.ts';
import { isUndeliverableRecipient, undeliverableDomainsFor } from '../../src/dispatcher/recipients.ts';
import { parseDeliveryId } from '../../src/dispatcher/sources.ts';
import type { PendingDelivery } from '../../src/dispatcher/sources.ts';

const tenantA = '70000000-0000-4000-8000-00000000000a';
const tenantB = '70000000-0000-4000-8000-00000000000b';
const entityA = '71000000-0000-4000-8000-00000000000a';
const entityB = '71000000-0000-4000-8000-00000000000b';
const inA = (deliveryId: string): PendingDelivery => ({ deliveryId, legalEntityId: entityA, tenantId: tenantA });
const inB = (deliveryId: string): PendingDelivery => ({ deliveryId, legalEntityId: entityB, tenantId: tenantB });

describe('delivery ids', () => {
  test('name the source subject the scoped reader fetches', () => {
    expect(parseDeliveryId('person-invitation:invite-1')).toEqual({
      source: 'person-invitation',
      subjectId: 'invite-1',
    });
    expect(parseDeliveryId('person-invitation:')).toBeNull();
    expect(parseDeliveryId('storefront-inquiry:task-1')).toEqual({ source: 'storefront-inquiry', subjectId: 'task-1' });
    expect(parseDeliveryId('rent-reminder:r-1')).toEqual({ source: 'rent-reminder', subjectId: 'r-1' });
    expect(parseDeliveryId('akros-order:o:1:SHIPPED')).toEqual({ source: 'akros-order', subjectId: 'o:1' });
    expect(parseDeliveryId('facility-agenda:p-1:2026-10-22T07:00:00.000Z')).toEqual({
      source: 'facility-agenda',
      subjectId: 'p-1',
    });
    for (const id of ['', 'rent-reminder:', 'akros-order:o', 'facility-agenda:p', 'other:x']) {
      expect(parseDeliveryId(id)).toBeNull();
    }
  });
});

describe('scope schedule', () => {
  test('groups by tenant + legal entity and never mixes their ids', () => {
    const work = scheduleScopes(
      [
        inA('rent-reminder:a1'),
        inB('rent-reminder:b1'),
        inA('akros-order:o1:ORDER_CREATED'),
        inA('akros-order:o1:SHIPPED'),
      ],
      10,
    );
    expect(work.map((w) => w.scope)).toEqual([
      { legalEntityId: entityA, tenantId: tenantA },
      { legalEntityId: entityB, tenantId: tenantB },
    ]);
    const [first, second] = work;
    if (first === undefined || second === undefined) {
      expect.unreachable('Missing scheduled scopes');
    }
    expect([...first.keys]).toEqual(['rent-reminder:a1', 'akros-order:o1:ORDER_CREATED', 'akros-order:o1:SHIPPED']);
    expect(first.subjects).toEqual({
      'akros-order': ['o1'],
      'facility-agenda': [],
      'person-invitation': [],
      'rent-reminder': ['a1'],
      'storefront-inquiry': [],
    });
    expect([...second.keys]).toEqual(['rent-reminder:b1']);
    expect(second.subjects['akros-order']).toEqual([]);
  });

  test('takes sources round-robin up to the batch size', () => {
    const orders = Array.from({ length: 5 }, (_, i) => inA(`akros-order:o${i}:ORDER_CREATED`));
    const work = scheduleScopes(
      [
        ...orders,
        inB('rent-reminder:b1'),
        inB('facility-agenda:p1:2026-10-22T07:00:00Z'),
        inB('person-invitation:invite-1'),
      ],
      4,
    );
    const keys = work.flatMap((w) => [...w.keys]);
    expect(keys).toHaveLength(4);
    expect(keys).toContain('rent-reminder:b1');
    expect(keys).toContain('facility-agenda:p1:2026-10-22T07:00:00Z');
    expect(keys).toContain('person-invitation:invite-1');
    expect(work.find((entry) => entry.scope.tenantId === tenantB)?.subjects['person-invitation']).toEqual(['invite-1']);
  });
});

describe('one person in two companies', () => {
  const agendaKey = 'facility-agenda:72000000-0000-4000-8000-000000000022:2026-10-21T09:00:00.000Z';
  const agendaEmail = (scope: { readonly legalEntityId: string; readonly tenantId: string }) =>
    ({
      ...scope,
      dedupeKey: agendaKey,
      event: 'AGENDA_NOTIFICATION',
      eventAt: '2026-10-21T09:00:00.000Z',
      eventLabel: 'Upozornění z agendy',
      from: 'OntOS <noreply@ontos.example.org>',
      html: '<p>Agenda</p>',
      recipient: 'jana.novakova@firma.cz',
      source: 'facility-agenda',
      subject: 'Upozornění z agendy',
      subjectId: '72000000-0000-4000-8000-000000000022:2026-10-21T09:00:00.000Z',
      subjectNumber: '',
      text: 'Agenda',
    }) satisfies PlannedEmail & { readonly from: string };

  test('schedules the same agenda batch key once in each company', () => {
    const work = scheduleScopes([inA(agendaKey), inB(agendaKey)], 10);
    expect(work.map((entry) => [entry.scope.tenantId, [...entry.keys]])).toEqual([
      [tenantA, [agendaKey]],
      [tenantB, [agendaKey]],
    ]);
  });

  it.effect('submits each company e-mail under its own provider idempotency key', () =>
    Effect.gen(function* submitBothCompanies() {
      const keys: (string | undefined)[] = [];
      const transport = {
        deliveryLayer: () =>
          Layer.succeed(EmailDeliveryService, {
            send: (message: { readonly idempotencyKey?: string }) =>
              Effect.sync(() => {
                keys.push(message.idempotencyKey);
                return { accepted: true as const, id: `accepted-${keys.length}` };
              }),
          }),
        kind: 'smtp' as const,
        provider: { configured: true, label: 'recording transport' },
      };
      const first = agendaEmail({ legalEntityId: entityA, tenantId: tenantA });
      const second = agendaEmail({ legalEntityId: entityB, tenantId: tenantB });
      yield* submitEmail(first, transport, {});
      yield* submitEmail(second, transport, {});
      const providerKey = /^ontos-delivery-v1:[0-9a-f]{64}$/u;
      const [firstKey, secondKey] = keys;
      expect(keys).toHaveLength(2);
      expect(firstKey).toMatch(providerKey);
      expect(secondKey).toMatch(providerKey);
      expect(firstKey).not.toBe(secondKey);
      expect(firstKey).toBe(yield* deliveryIdempotencyKey(first));
      expect(secondKey).toBe(yield* deliveryIdempotencyKey(second));
      // Another legal entity of the same tenant is another company.
      expect(yield* deliveryIdempotencyKey(agendaEmail({ legalEntityId: entityB, tenantId: tenantA }))).not.toBe(
        firstKey,
      );
      // Bounded for any dedupe key: the Resend adapter refuses keys over 256 characters.
      const long = yield* deliveryIdempotencyKey({ ...first, dedupeKey: `akros-order:${'x'.repeat(1000)}:SHIPPED` });
      expect(long).toMatch(providerKey);
      expect(long).toHaveLength(82);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe('undeliverable recipients', () => {
  test('seeded fake addresses are skipped in every runtime', () => {
    for (const transport of ['smtp', 'cloudflare'] as const) {
      const domains = undeliverableDomainsFor(transport, {});
      for (const address of ['ucetni@demo.ontos', 'management@najempark.demo', 'demo@test.com', 'x@akros.demo']) {
        expect(isUndeliverableRecipient(address, domains)).toBe(true);
      }
      expect(isUndeliverableRecipient('jana.novakova@firma.cz', domains)).toBe(false);
    }
  });

  test('documentation domains reach the local Mailpit but are skipped on Workers', () => {
    expect(isUndeliverableRecipient('zakaznik@example.com', undeliverableDomainsFor('smtp', {}))).toBe(false);
    expect(isUndeliverableRecipient('zakaznik@example.com', undeliverableDomainsFor('cloudflare', {}))).toBe(true);
    expect(undeliverableDomainsFor('smtp', { ONTOS_EMAIL_UNDELIVERABLE_DOMAINS: 'firma.cz' })).toBe('firma.cz');
  });
});
