// @rstest-environment happy-dom
// Closing with a typed note asks first; closing without one leaves at once. The dialog uses the real module i18n,
// TanStack router blocker and select template.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, unmountAll } from '@app/admin-ui/testing/module-ui';
import { Effect, Option } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { StageDialog } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-dialogs.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const copy = {
  cancel: czech('sales-pipeline.pages.records.stageDialog.cancel'),
  description: 'description',
  note: 'Zákazník čeká na nabídku',
} as const;

const mount = (events: string[]) =>
  mountInRoute(
    <StageDialog
      busy={false}
      currentStage="LEAD"
      description={copy.description}
      onOpenChange={(open) => {
        events.push(open ? 'open' : 'closed');
      }}
      onSubmit={() => {
        events.push('submitted');
      }}
      showNote
    />,
    { path: 'prodej/prilezitosti', url: '/cs/prodej/prilezitosti' },
  );

const button = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));

const typeNote = (value: string) =>
  acted(() => {
    const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLTextAreaElement>('#stage-note')));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

afterEach(unmountAll);

describe('stage dialog note', () => {
  it.live('closing without a note leaves at once', () =>
    Effect.gen(function* closeWithoutNote() {
      const events: string[] = [];
      yield* mount(events);
      yield* acted(() => button(copy.cancel).click());
      expect(buttons(labels.discard)).toHaveLength(0);
      expect(events).toEqual(['closed']);
    }),
  );

  it.live('closing with a typed note asks first; Zůstat keeps it, Zahodit změny leaves', () =>
    Effect.gen(function* guardTypedNote() {
      const events: string[] = [];
      yield* mount(events);
      yield* typeNote(copy.note);
      yield* acted(() => button(copy.cancel).click());
      expect(buttons(labels.discard)).toHaveLength(1);
      expect(events).toEqual([]);

      yield* acted(() => button(labels.stay).click());
      expect(events).toEqual([]);
      expect(document.querySelector<HTMLTextAreaElement>('#stage-note')?.value).toBe(copy.note);

      yield* acted(() => button(copy.cancel).click());
      yield* acted(() => button(labels.discard).click());
      expect(events).toEqual(['closed']);
    }),
  );
});
