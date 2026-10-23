// @effect-diagnostics *:off
import { describe, expect, test } from '@rstest/core';
import { scheduleScopes } from '../../src/dispatcher/dispatch.ts';
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
    expect(parseDeliveryId('storefront-inquiry:task-1')).toEqual({ source: 'storefront-inquiry', subjectId: 'task-1' });
    expect(parseDeliveryId('rent-reminder:r-1')).toEqual({ source: 'rent-reminder', subjectId: 'r-1' });
    expect(parseDeliveryId('akros-order:o:1:SHIPPED')).toEqual({ source: 'akros-order', subjectId: 'o:1' });
    expect(parseDeliveryId('facility-agenda:p-1:2026-10-22T07:00:00.000Z')).toEqual({
      source: 'facility-agenda',
      subjectId: 'p-1',
    });
    for (const id of ['', 'rent-reminder:', 'akros-order:o', 'facility-agenda:p', 'other:x'])
      expect(parseDeliveryId(id)).toBeNull();
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
    expect([...work[0]!.keys]).toEqual(['rent-reminder:a1', 'akros-order:o1:ORDER_CREATED', 'akros-order:o1:SHIPPED']);
    expect(work[0]!.subjects).toEqual({
      'akros-order': ['o1'],
      'facility-agenda': [],
      'rent-reminder': ['a1'],
      'storefront-inquiry': [],
    });
    expect([...work[1]!.keys]).toEqual(['rent-reminder:b1']);
    expect(work[1]!.subjects['akros-order']).toEqual([]);
  });

  test('takes sources round-robin up to the batch size', () => {
    const orders = Array.from({ length: 5 }, (_, i) => inA(`akros-order:o${i}:ORDER_CREATED`));
    const work = scheduleScopes(
      [...orders, inB('rent-reminder:b1'), inB('facility-agenda:p1:2026-10-22T07:00:00Z')],
      4,
    );
    const keys = work.flatMap((w) => [...w.keys]);
    expect(keys).toHaveLength(4);
    expect(keys).toContain('rent-reminder:b1');
    expect(keys).toContain('facility-agenda:p1:2026-10-22T07:00:00Z');
  });
});

describe('undeliverable recipients', () => {
  test('seeded fake addresses are skipped in every runtime', () => {
    for (const transport of ['smtp', 'cloudflare'] as const) {
      const domains = undeliverableDomainsFor(transport, {});
      for (const address of ['ucetni@demo.ontos', 'management@siampark.demo', 'demo@test.com', 'x@akros.demo'])
        expect(isUndeliverableRecipient(address, domains)).toBe(true);
      expect(isUndeliverableRecipient('jana.novakova@firma.cz', domains)).toBe(false);
    }
  });

  test('documentation domains reach the local Mailpit but are skipped on Workers', () => {
    expect(isUndeliverableRecipient('zakaznik@example.com', undeliverableDomainsFor('smtp', {}))).toBe(false);
    expect(isUndeliverableRecipient('zakaznik@example.com', undeliverableDomainsFor('cloudflare', {}))).toBe(true);
    expect(undeliverableDomainsFor('smtp', { ONTOS_EMAIL_UNDELIVERABLE_DOMAINS: 'firma.cz' })).toBe('firma.cz');
  });
});
