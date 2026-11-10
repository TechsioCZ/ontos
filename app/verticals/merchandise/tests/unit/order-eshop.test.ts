import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { OrderHistoryEntrySchema } from '../../shared/domain/merchandise-model.ts';
import {
  historyActorLabel,
  historyKindKeys,
  workflowSteps,
} from '../../src/routes/[lang]/prodej/objednavky/order-eshop.ts';

/** Echoes the key and its parameters, so each test can read which message the label asked for. */
const translate = (key: string | string[], ...args: unknown[]) => `${String(key)}:${JSON.stringify(args)}`;

const tenantId = '0b2f6f4e-3c1a-4d8e-9a7b-5c6d7e8f9a0b';
const administratorId = 'cdfa4353-77ab-5b46-9dc9-b1119ae0d5a9';
const unknownId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

interface HistoryEntryFields {
  readonly actor?: { readonly principalId: string; readonly tenantId: string };
  readonly actorLabel?: string;
}

const historyEntry = (fields: HistoryEntryFields) =>
  Schema.decodeUnknownSync(OrderHistoryEntrySchema)({ at: '2026-01-01T10:00:00.000Z', kind: 'NOTE', ...fields });

const actor = (principalId: string) => ({ principalId, tenantId });

it('shows the label stored with the entry before any lookup', () => {
  const entry = historyEntry({ actor: actor(administratorId), actorLabel: 'Import ze zdroje' });
  expect(historyActorLabel(entry, undefined, translate)).toBe('Import ze zdroje');
});

it('names an entry without an actor as the system', () => {
  expect(historyActorLabel(historyEntry({}), undefined, translate)).toBe(
    'merchandise.pages.orders.eshop.actor.system:[]',
  );
});

it('names a known demo account with its e-mail and marks the current user', () => {
  const entry = historyEntry({ actor: actor(administratorId) });
  expect(historyActorLabel(entry, undefined, translate)).toBe(
    'merchandise.pages.orders.eshop.actor.withEmail:[{"email":"eshop@kavarna.demo","label":"merchandise.pages.orders.eshop.actor.administrator:[]"}]',
  );
  expect(historyActorLabel(entry, administratorId, translate)).toBe(
    String.raw`merchandise.pages.orders.eshop.actor.youAs:[{"label":"merchandise.pages.orders.eshop.actor.withEmail:[{\"email\":\"eshop@kavarna.demo\",\"label\":\"merchandise.pages.orders.eshop.actor.administrator:[]\"}]"}]`,
  );
});

it('falls back to the generic staff label, or to the plain you for the current user', () => {
  const entry = historyEntry({ actor: actor(unknownId) });
  expect(historyActorLabel(entry, undefined, translate)).toBe('merchandise.pages.orders.eshop.actor.unknown:[]');
  expect(historyActorLabel(entry, unknownId, translate)).toBe('merchandise.pages.orders.eshop.actor.you:[]');
});

it('keeps every history kind and workflow step on a message key, not on Czech text', () => {
  for (const key of [...Object.values(historyKindKeys), ...workflowSteps.map((step) => step.labelKey)]) {
    expect(key.startsWith('merchandise.pages.orders.eshop.')).toBe(true);
  }
});
