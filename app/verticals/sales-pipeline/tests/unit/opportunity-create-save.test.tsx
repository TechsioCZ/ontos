// @rstest-environment happy-dom
// The create panel of an opportunity as the user sees it: typing and picking change only the draft, Enter sends
// nothing, the shared Save button ("Uložit", last in the footer) creates the opportunity once, an untouched panel
// closes without asking and a refused create keeps the input. The panel runs under the module
// i18n and router with the real ui-kit combobox and select.
import { requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { pinTestDocument } from '@app/shared-contracts/testing/http-double';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { PartyIdSchema } from '../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { OpportunityCreatePanel } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-create-panel.tsx';
import type { CreateCommand } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-fields.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const copy = {
  cancel: moduleText('cs')('sales-pipeline.pages.records.create.cancel'),
  close: '2026-12-01',
  title: 'Dodávka regálů',
} as const;
const partyId = Schema.decodeSync(PartyIdSchema)('10000000-0000-4000-8000-000000000001');

const created: CreateCommand[] = [];
let answer: SaveOutcome = 'saved';

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
            return answer;
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
  answer = 'saved';
});

afterEach(unmountAll);

describe('opportunity create panel with the shared Uložit', () => {
  it.live('reads the required text of a required field in Czech', () =>
    Effect.gen(function* requiredCzechCopy() {
      yield* mount([]);
      expect(document.body.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
      expect(document.querySelector('label[for="opportunity-title"]')?.textContent).toContain(requiredLabelFor('cs'));
    }),
  );

  it.live('typing sends nothing; one click on Uložit creates the opportunity once', () =>
    Effect.gen(function* createOnce() {
      const events: string[] = [];
      yield* mount(events);
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);

      yield* fillIn;
      yield* acted(() => field('opportunity-title').form?.requestSubmit());
      expect(created).toEqual([]);

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

  it.live('an untouched panel closes without asking; typed input asks first', () =>
    Effect.gen(function* confirmDirtyClose() {
      const events: string[] = [];
      yield* mount(events);
      yield* acted(() => button(copy.cancel).click());
      expect(buttons(labels.discard)).toHaveLength(0);
      expect(events).toEqual(['closed']);

      yield* typeInto('opportunity-title', copy.title);
      yield* acted(() => button(copy.cancel).click());
      expect(buttons(labels.discard)).toHaveLength(1);
      expect(events).toEqual(['closed']);
    }),
  );

  it.live('a refused create keeps the input and the panel open', () =>
    Effect.gen(function* retainRefusedDraft() {
      answer = 'failed';
      const events: string[] = [];
      yield* mount(events);
      yield* fillIn;
      yield* acted(() => button(labels.save).click());
      expect(created).toHaveLength(1);
      expect(field('opportunity-title').value).toBe(copy.title);
      expect(events).toEqual([]);
      expect(document.querySelector<HTMLElement>('[data-save-state]')?.dataset.saveState).toBe('error');
    }),
  );
});
