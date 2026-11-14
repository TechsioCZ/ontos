// @rstest-environment happy-dom
// The bulk change by tag as the user sees it: choosing the tag and the new stage sends nothing, the shared Save button
// ("Uložit", last in the footer) sends one bulk command for the previewed opportunities, an untouched panel closes
// without asking and a started choice asks first. The opportunity and tag reads, the command, the router blocker, the
// i18n runtime, the tag filter (by one button) and the select template (by a native select) are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BulkByTagDialog } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-bulk-by-tag.tsx';
import type { BulkByTagResult } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-bulk-by-tag.tsx';
import type { PipelineCommand } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-api.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

/** The props the stand-in of the select template reads. */
interface NativeSelectProps {
  readonly items: readonly { readonly label: string; readonly value: string }[];
  readonly name?: string;
  readonly onValueChange: (details: { readonly value: string[] }) => void;
  readonly value?: readonly string[];
}

const { sent } = rstest.hoisted(() => {
  const commands: { readonly command: PipelineCommand; readonly revision: number }[] = [];
  return { sent: commands };
});

const opportunity = { id: 'opp-1', partyId: 'party-1', stage: 'LEAD', title: 'Regály' } as const;

rstest.mock('../../src/routes/[lang]/prodej/prilezitosti/pipeline-references.ts', () => ({
  useAllOpportunities: () => ({ items: { items: [opportunity], revision: 3 }, status: 'ready' }),
  useSubjectIdsWithTag: (_kind: string, tagId: string | null) =>
    tagId === null ? undefined : { items: new Set([opportunity.partyId]), status: 'ready' },
}));
rstest.mock('../../src/routes/[lang]/prodej/prilezitosti/pipeline-api.ts', () => ({
  applyPipelineCommand: (command: PipelineCommand, revision: number) =>
    Effect.sync(() => {
      sent.push({ command, revision });
      return { opportunities: [opportunity], revision: 4 };
    }),
}));
rstest.mock('@app/tagging/components/tag-controls', () => ({
  TagFilter: ({ onChange }: { readonly onChange: (tagId: string | null) => void }) =>
    createElement('button', { 'data-testid': 'tag-filter-pick', onClick: () => onChange('tag-1'), type: 'button' }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@app/admin-ui/select-template', () => ({
  SelectTemplate: ({ items, name, onValueChange, value }: NativeSelectProps) =>
    createElement(
      'select',
      {
        name,
        onChange: (event: { readonly target: { readonly value: string } }) =>
          onValueChange({ value: event.target.value === '' ? [] : [event.target.value] }),
        value: value?.[0] ?? '',
      },
      createElement('option', { value: '' }),
      ...items.map((item) => createElement('option', { key: item.value, value: item.value }, item.label)),
    ),
}));

const labels = saveLabelsFor('cs');
const copy = { cancel: 'sales-pipeline.pages.records.bulkByTag.cancel', stage: 'NEGOTIATION' } as const;

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const views: (() => void)[] = [];

const mount = async (events: string[], done: BulkByTagResult[]) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  views.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <BulkByTagDialog
        activeEmployees={[]}
        customerLabel={(partyId) => partyId}
        onDone={(result) => {
          done.push(result);
        }}
        onOpenChange={(open) => {
          events.push(open ? 'open' : 'closed');
        }}
      />,
    );
  });
  await settle();
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const button = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));

const step = async (run: () => void) => {
  await act(async () => {
    run();
  });
  await settle();
};

const pickTag = () =>
  step(() => {
    Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLElement>('[data-testid="tag-filter-pick"]')),
    ).click();
  });

const pickStage = () =>
  step(() => {
    const select = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLSelectElement>('select[name="stage"]')),
    );
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, copy.stage);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sent.length = 0;
});

afterEach(() => {
  for (const unmount of views.splice(0)) {
    unmount();
  }
  rstest.unstubAllGlobals();
});

describe('bulk change by tag with the shared Uložit', () => {
  it.live('choosing sends nothing; one click on Uložit sends one bulk command for the preview', () =>
    Effect.promise(async () => {
      const events: string[] = [];
      const done: BulkByTagResult[] = [];
      await mount(events, done);
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);

      await pickTag();
      await pickStage();
      expect(sent).toEqual([]);

      await step(() => button(labels.save).click());
      expect(sent).toEqual([
        {
          command: { _tag: 'BulkUpdateOpportunities', ids: [opportunity.id], patch: { stage: copy.stage } },
          revision: 3,
        },
      ]);
      expect(done).toHaveLength(1);
      expect(done[0]?.changed).toBe(1);
    }),
  );

  it.live('an untouched panel closes without asking; a started choice asks first', () =>
    Effect.promise(async () => {
      const events: string[] = [];
      await mount(events, []);
      await step(() => button(copy.cancel).click());
      expect(buttons(labels.discard)).toHaveLength(0);
      expect(events).toEqual(['closed']);

      await pickTag();
      await step(() => button(copy.cancel).click());
      expect(buttons(labels.discard)).toHaveLength(1);
      expect(events).toEqual(['closed']);
      expect(sent).toEqual([]);
    }),
  );
});
