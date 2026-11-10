// @rstest-environment happy-dom
// The bulk tag panel as the user sees it: picking the tag and add/remove sends nothing, the shared Save button
// ("Uložit", last in the footer) applies the tag once to every selected subject, an untouched panel closes without
// asking and a started choice asks first. The tagging clients, the router, the i18n runtime and the ui-kit combobox
// are replaced; the combobox by one button per offered tag.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { SubjectIdSchema, TagSchema } from '../../shared/apis/records.ts';
import type { Subject, Tag, TagId } from '../../shared/apis/records.ts';
import { BulkTagDialog } from '../../src/components/tag-controls.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

/** The props the stand-in of the ui-kit combobox reads. */
interface ComboboxStandInProps {
  readonly items: readonly { readonly label: string; readonly value: string }[];
  readonly onChange: (value: string[]) => void;
}

interface Write {
  readonly mode: string;
  readonly subjects: readonly Subject[];
  readonly tagId: TagId;
}

const { catalog, writes } = rstest.hoisted(() => {
  const tags: unknown[] = [];
  const written: Write[] = [];
  return { catalog: { tags }, writes: written };
});

rstest.mock('../../src/api/records-consumer.ts', () => ({
  get listTags() {
    return Effect.sync(() => catalog.tags);
  },
  recordsOfKind: rstest.fn(),
}));
rstest.mock('../../src/api/records-commands.ts', () => ({
  assignTag: (tagId: TagId, subjects: readonly Subject[]) =>
    Effect.sync(() => {
      writes.push({ mode: 'add', subjects, tagId });
    }),
  unassignTag: (tagId: TagId, subjects: readonly Subject[]) =>
    Effect.sync(() => {
      writes.push({ mode: 'remove', subjects, tagId });
    }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
// One button per offered tag in place of the ui-kit combobox: a click picks that tag.
rstest.mock('@techsio/ui-kit/molecules/combobox', () => ({
  Combobox: ({ items, onChange }: ComboboxStandInProps) =>
    createElement(
      'div',
      null,
      ...items.map((item) =>
        createElement(
          'button',
          {
            'data-testid': `tag-option-${item.value}`,
            key: item.value,
            onClick: () => onChange([item.value]),
            type: 'button',
          },
          item.label,
        ),
      ),
    ),
}));

const labels = saveLabelsFor('cs');
const copy = { cancel: 'tagging.tags.form.cancel' } as const;

const vip: Tag = Schema.decodeUnknownSync(TagSchema)({
  color: 'blue',
  createdAt: '2026-10-05T10:00:00.000Z',
  id: 'tag-vip',
  name: 'VIP',
  subjectKinds: ['customer'],
  updatedAt: '2026-10-05T10:00:00.000Z',
});
const subjectIds = ['customer-1', 'customer-2'].map((id) => Schema.decodeSync(SubjectIdSchema)(id));

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

interface View {
  readonly events: string[];
  readonly unmount: () => void;
}

const views: View[] = [];

const mount = async (): Promise<View> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const events: string[] = [];
  await act(async () => {
    root.render(
      <BulkTagDialog
        kind="customer"
        onDone={() => {
          events.push('done');
        }}
        onOpenChange={(open) => {
          events.push(open ? 'open' : 'closed');
        }}
        open
        subjectIds={subjectIds}
      />,
    );
    await settle();
  });
  const view: View = {
    events,
    unmount: () => {
      act(() => {
        root.unmount();
        container.remove();
      });
    },
  };
  views.push(view);
  return view;
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const button = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));

const byTestId = (id: string): HTMLElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLElement>(`[data-testid="${id}"]`)));

const click = async (target: HTMLElement) => {
  await act(async () => {
    target.click();
    await settle();
  });
};

const pickVip = async () => {
  await waitUntil(() => document.querySelector(`[data-testid="tag-option-${vip.id}"]`) !== null);
  await click(byTestId(`tag-option-${vip.id}`));
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  catalog.tags = [vip];
  writes.length = 0;
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.unmount();
  }
  rstest.unstubAllGlobals();
});

describe('bulk tag panel with the shared Uložit', () => {
  it.effect('picking sends nothing; one click on Uložit tags every selected subject once and closes', () =>
    Effect.gen(function* applyOnce() {
      const view = yield* Effect.promise(mount);
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);

      yield* Effect.promise(pickVip);
      expect(writes).toEqual([]);
      expect(button(labels.save).disabled).toBe(false);

      yield* Effect.promise(() => click(button(labels.save)));
      yield* Effect.promise(() => waitUntil(() => view.events.includes('closed')));
      expect(writes).toEqual([
        {
          mode: 'add',
          subjects: subjectIds.map((id) => ({ id, kind: 'customer' })),
          tagId: vip.id,
        },
      ]);
      expect(view.events).toEqual(['done', 'closed']);
    }),
  );

  it.effect('an untouched panel closes without asking', () =>
    Effect.gen(function* untouched() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => click(button(copy.cancel)));
      expect(buttons(labels.discard)).toHaveLength(0);
      expect(view.events).toEqual(['closed']);
    }),
  );

  it.effect('a started choice asks before leaving; Zahodit změny leaves without tagging', () =>
    Effect.gen(function* leave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(pickVip);
      yield* Effect.promise(() => click(button(copy.cancel)));
      expect(buttons(labels.discard)).toHaveLength(1);
      expect(view.events).toEqual([]);

      yield* Effect.promise(() => click(button(labels.discard)));
      expect(view.events).toEqual(['closed']);
      expect(writes).toEqual([]);
    }),
  );
});
