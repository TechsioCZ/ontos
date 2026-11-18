// @rstest-environment happy-dom
// The create panel binds the chosen customer, title and close date to the opportunity command.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { pinTestDocument } from '@app/shared-contracts/testing/http-double';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { PartyIdSchema } from '../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { OpportunityCreatePanel } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-create-panel.tsx';
import type { CreateCommand } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-fields.tsx';
import { mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const copy = {
  close: '2026-12-01',
  title: 'Dodávka regálů',
} as const;
const partyId = Schema.decodeSync(PartyIdSchema)('10000000-0000-4000-8000-000000000001');

const created: CreateCommand[] = [];

const mount = (events: string[]) =>
  Effect.gen(function* mountPanel() {
    yield* pinTestDocument;
    yield* mountInRoute(
      <OpportunityCreatePanel
        customers={{
          items: [{ archived: false, companyId: null, counterpartyId: 'cp-1', id: partyId, name: 'Akros CZ' }],
          status: 'ready',
        }}
        employees={{ items: [], status: 'ready' }}
        onCreate={(command) =>
          Effect.sync(() => {
            created.push(command);
            return 'saved' as const;
          })
        }
        onCreated={() => {
          events.push('created');
        }}
        onOpenChange={(open) => {
          events.push(open ? 'open' : 'closed');
        }}
        products={{ items: [], status: 'ready' }}
      />,
      { path: 'prodej/prilezitosti', url: '/cs/prodej/prilezitosti' },
    );
    yield* waitUntil(() => document.querySelector('[id="opportunity-title"]') !== null);
  });

const button = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));

const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));

const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const fillIn = Effect.gen(function* fillDraft() {
  yield* acted(() => {
    Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[role="combobox"]'))).click();
  });
  yield* waitUntil(() => document.querySelector(`[role="option"][data-value="${partyId}"]`) !== null);
  yield* acted(() => {
    Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLElement>(`[role="option"][data-value="${partyId}"]`)),
    ).click();
  });
  yield* typeInto('opportunity-title', copy.title);
  yield* typeInto('opportunity-close-date', copy.close);
});

beforeEach(() => {
  created.length = 0;
});

afterEach(unmountAll);

describe('opportunity create command', () => {
  it.live('sends the chosen customer and close date with the opportunity title', () =>
    Effect.gen(function* createOnce() {
      const events: string[] = [];
      yield* mount(events);

      yield* fillIn;

      yield* acted(() => button(labels.save).click());
      expect(created).toEqual([
        {
          _tag: 'CreateOpportunity',
          expectedCloseDate: copy.close,
          lines: [],
          note: '',
          partyId,
          title: copy.title,
        },
      ]);
      expect(events).toEqual(['created']);
    }),
  );
});
