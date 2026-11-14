import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { useState } from 'react';
import { useRecordDraft } from '../../src/draft-save.ts';
import type { SaveOutcome } from '../../src/draft-save.ts';
import { SaveBar } from '../../src/save-bar.tsx';
import { SidePanel } from '../../src/side-panel.tsx';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '../../src/unsaved-changes.tsx';

const copy = { confirmation: 'Confirm discard', title: 'Panel details' };

/**
 * A panel owner like the demo's create forms, which have no save bar and no unsaved-changes guard: a guarded owner
 * asks on its own before an edited draft is dropped. `saved` adds a settled save bar of an unguarded edit form.
 */
const PanelExample = ({ guarded = false, saved = false }: { readonly guarded?: boolean; readonly saved?: boolean }) => {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open panel
      </button>
      <SidePanel
        onOpenChange={(next) => {
          if (!next && guarded && dirty) {
            setDiscardOpen(true);
            return;
          }
          setOpen(next);
        }}
        open={open}
        resizeLabel="Resize panel"
        title={copy.title}
      >
        <label>
          Draft
          <input onChange={() => setDirty(true)} />
        </label>
        {saved && <div data-save-state={dirty ? 'saved' : 'idle'} />}
      </SidePanel>
      <Dialog
        customTrigger
        onOpenChange={({ open: next }) => setDiscardOpen(next)}
        open={discardOpen}
        role="alertdialog"
        title={copy.confirmation}
      />
    </>
  );
};

afterEach(cleanup);

const openPanel = Effect.fn('openPanel')(function* openPanel(guarded = false, saved = false) {
  render(<PanelExample guarded={guarded} saved={saved} />);
  const trigger = screen.getByRole('button', { name: 'Open panel' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = yield* Effect.promise(() => screen.findByRole('dialog', { name: copy.title }));
  // The focus trap and outside-interaction listeners start after the content mounts.
  yield* Effect.promise(() => waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true)));
  return { dialog, trigger };
});

/** The gray area is the modal positioner around the panel; it must take the pointer itself. */
const clickBackdrop = (dialog: HTMLElement) => {
  const positioner = dialog.parentElement;
  expect(positioner?.dataset['part']).toBe('positioner');
  expect(positioner?.classList.contains('pointer-events-auto')).toBe(true);
  if (positioner !== null) {
    fireEvent.pointerDown(positioner, { button: 0, clientX: 0, clientY: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(positioner, { button: 0, clientX: 0, clientY: 0, pointerType: 'mouse' });
    fireEvent.click(positioner);
  }
};

it.effect('closes on the gray backdrop, releases scroll lock and returns focus', () =>
  Effect.gen(function* backdropClose() {
    const { dialog, trigger } = yield* openPanel();
    yield* Effect.promise(() => waitFor(() => expect(document.body.style.overflow).toBe('hidden')));
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    clickBackdrop(dialog);
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()));
    yield* Effect.promise(() => waitFor(() => expect(document.activeElement).toBe(trigger)));
    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.pointerEvents).toBe('');
  }),
);

it.effect('closes on Escape and returns focus', () =>
  Effect.gen(function* escapeClose() {
    const { dialog, trigger } = yield* openPanel();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()));
    yield* Effect.promise(() => waitFor(() => expect(document.activeElement).toBe(trigger)));
  }),
);

it.effect('closes with the labelled close button', () =>
  Effect.gen(function* buttonClose() {
    yield* openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Zavřít' }));
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()));
  }),
);

it.effect('does not close for interactions inside the panel', () =>
  Effect.gen(function* insideInteraction() {
    const { dialog } = yield* openPanel();
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Draft' }), { pointerType: 'mouse' });
    expect(screen.getByRole('dialog')).toBe(dialog);
  }),
);

const editDraft = () => {
  const input = screen.getByRole('textbox', { name: 'Draft' });
  input.focus();
  fireEvent.input(input, { target: { value: 'Unsaved draft' } });
  fireEvent.change(input, { target: { value: 'Unsaved draft' } });
  return input;
};

it.effect('keeps an edited draft open on the backdrop and closes it only on request', () =>
  Effect.gen(function* keptDraft() {
    const { dialog, trigger } = yield* openPanel();
    const input = editDraft();
    clickBackdrop(dialog);
    const notice = yield* Effect.promise(() => screen.findByRole('status'));
    expect(notice.textContent).toContain('Neuložené změny zůstaly zachované.');
    expect(dialog.isConnected).toBe(true);
    expect(dialog.dataset['state']).toBe('open');
    expect(input).toHaveProperty('value', 'Unsaved draft');
    // The outside press may move focus away; the panel puts it back on the edited field.
    trigger.focus();
    clickBackdrop(dialog);
    yield* Effect.promise(() => waitFor(() => expect(document.activeElement).toBe(input)));
    fireEvent.click(screen.getByRole('button', { name: 'Zavřít bez uložení' }));
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()));
    yield* Effect.promise(() => waitFor(() => expect(document.activeElement).toBe(trigger)));
  }),
);

it.effect('still closes an edited draft on Escape', () =>
  Effect.gen(function* escapeEdited() {
    const { dialog } = yield* openPanel();
    editDraft();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()));
  }),
);

it.effect('lets a form whose save bar is settled close from the backdrop', () =>
  Effect.gen(function* settledClose() {
    const { dialog } = yield* openPanel(false, true);
    editDraft();
    clickBackdrop(dialog);
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()));
  }),
);

/** A quick view over a list: the row behind the panel keeps working while the panel is open. */
const PeekExample = ({ onRowClick }: { readonly onRowClick: () => void }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open row
      </button>
      <button onClick={onRowClick} type="button">
        Next row
      </button>
      <SidePanel onOpenChange={setOpen} open={open} peek resizeLabel="Resize panel" title={copy.title}>
        <label>
          Draft
          <input />
        </label>
      </SidePanel>
    </>
  );
};

const openPeek = Effect.fn('openPeek')(function* openPeek(onRowClick: () => void) {
  render(<PeekExample onRowClick={onRowClick} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open row' }));
  const dialog = yield* Effect.promise(() => screen.findByRole('dialog', { name: copy.title }));
  return dialog;
});

it.effect('keeps the default panel modal', () =>
  Effect.gen(function* defaultPanel() {
    const { dialog } = yield* openPanel();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.parentElement?.classList.contains('pointer-events-auto')).toBe(true);
  }),
);

it.effect('renders a peek panel as a modeless dialog without a backdrop', () =>
  Effect.gen(function* peekDom() {
    const dialog = yield* openPeek(() => {});
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    expect(document.querySelector("[data-scope='dialog'][data-part='backdrop']")).toBeNull();
  }),
);

it.effect('keeps a peek panel open for outside presses and keeps the list behind it clickable', () =>
  Effect.gen(function* peekOutside() {
    let rowClicks = 0;
    const dialog = yield* openPeek(() => {
      rowClicks += 1;
    });
    const row = screen.getByRole('button', { name: 'Next row' });
    fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(row, { button: 0, clientX: 0, clientY: 0, pointerType: 'mouse' });
    fireEvent.click(row);
    expect(rowClicks).toBe(1);
    yield* Effect.promise(() => waitFor(() => expect(dialog.dataset['state']).toBe('open')));
    expect(screen.getByRole('dialog', { name: copy.title })).toBe(dialog);
    expect(document.body.style.overflow).toBe('');
  }),
);

it.effect('still closes a peek panel on Escape and with the close button', () =>
  Effect.gen(function* peekClose() {
    const dialog = yield* openPeek(() => {});
    fireEvent.keyDown(dialog, { key: 'Escape' });
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()));
    fireEvent.click(screen.getByRole('button', { name: 'Open row' }));
    yield* Effect.promise(() => screen.findByRole('dialog', { name: copy.title }));
    fireEvent.click(screen.getByRole('button', { name: 'Zavřít' }));
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()));
  }),
);

it.effect('asks the draft owner once when the kept draft is closed on request', () =>
  Effect.gen(function* guardedClose() {
    const { dialog } = yield* openPanel(true);
    const input = editDraft();
    clickBackdrop(dialog);
    yield* Effect.promise(() => screen.findByRole('status'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zavřít bez uložení' }));
    const confirmation = yield* Effect.promise(() => screen.findByRole('alertdialog', { name: copy.confirmation }));
    expect(dialog.dataset['state']).toBe('open');
    expect(input).toHaveProperty('value', 'Unsaved draft');
    yield* Effect.promise(() => waitFor(() => expect(confirmation.contains(document.activeElement)).toBe(true)));
    fireEvent.keyDown(confirmation, { key: 'Escape' });
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()));
    expect(screen.getByRole('dialog', { name: copy.title })).toBe(dialog);
    expect(input).toHaveProperty('value', 'Unsaved draft');
  }),
);

const runtime = ManagedRuntime.make(Layer.empty);

interface Saves {
  /** One entry per time the owner closed the panel. */
  readonly closed: string[];
  readonly replies: Deferred.Deferred<SaveOutcome>[];
  readonly sent: string[];
}

const useNameDraft = (saves: Saves) =>
  useRecordDraft<string, never>({
    isValid: (value) => value.trim() !== '',
    runtime,
    save: (value) =>
      Effect.suspend(() => {
        saves.sent.push(value);
        const reply = Deferred.makeUnsafe<SaveOutcome>();
        saves.replies.push(reply);
        return Deferred.await(reply);
      }),
    server: 'Akros',
  });

type NameDraft = ReturnType<typeof useNameDraft>;

const useNameGuard = (record: NameDraft) => useUnsavedChangesGuard({ draft: record, onDiscard: record.discard });

const NameField = ({ record }: { readonly record: NameDraft }) => (
  <label>
    Draft
    <input onChange={(event) => record.setDraft(event.target.value)} value={record.draft} />
  </label>
);

const NameSaveBar = ({ record }: { readonly record: NameDraft }) => {
  const handleReloadLatest = record.reloadLatest;
  const handleSave = record.save;
  return <SaveBar onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />;
};

/** The edit form somewhere inside a panel another component renders: its guard is found by the panel. */
const InnerEditForm = ({ saves }: { readonly saves: Saves }) => {
  const record = useNameDraft(saves);
  const guard = useNameGuard(record);
  return (
    <>
      <NameField record={record} />
      <NameSaveBar record={record} />
      <UnsavedChangesDialog prompt={guard.prompt} />
    </>
  );
};

/** The edit form that renders its own panel: it hands the guard to the panel, with the save bar in the footer. */
const OwnPanelEditForm = ({ onClose, saves }: { readonly onClose: () => void; readonly saves: Saves }) => {
  const record = useNameDraft(saves);
  const guard = useNameGuard(record);
  return (
    <>
      <SidePanel
        actions={
          <>
            <button onClick={() => guard.request(onClose)} type="button">
              Zavřít formulář
            </button>
            <NameSaveBar record={record} />
          </>
        }
        guard={guard}
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open
        resizeLabel="Resize panel"
        title={copy.title}
      >
        <NameField record={record} />
      </SidePanel>
      <UnsavedChangesDialog prompt={guard.prompt} />
    </>
  );
};

const EditPanelExample = ({ own, saves }: { readonly own: boolean; readonly saves: Saves }) => {
  const [open, setOpen] = useState(false);
  const close = () => {
    saves.closed.push('closed');
    setOpen(false);
  };
  const panel = own ? (
    <OwnPanelEditForm onClose={close} saves={saves} />
  ) : (
    <SidePanel
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      open
      resizeLabel="Resize panel"
      title={copy.title}
    >
      <InnerEditForm saves={saves} />
    </SidePanel>
  );
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open panel
      </button>
      {open && panel}
    </>
  );
};

const openEditPanel = Effect.fn('openEditPanel')(function* openEditPanel(own: boolean) {
  const saves: Saves = { closed: [], replies: [], sent: [] };
  render(<EditPanelExample own={own} saves={saves} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open panel' }));
  const dialog = yield* Effect.promise(() => screen.findByRole('dialog', { name: copy.title }));
  yield* Effect.promise(() => waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true)));
  return { dialog, saves };
});

const question = () => screen.findByRole('alertdialog', { name: 'Neuložené změny' });
const panelIsOpen = () => screen.queryByRole('dialog', { hidden: true, name: copy.title }) !== null;

for (const own of [true, false]) {
  describe(own ? 'a panel given the guard of its edit form' : 'a panel around an edit form with a guard', () => {
    it.effect('closes a clean form at once', () =>
      Effect.gen(function* clean() {
        const { dialog, saves } = yield* openEditPanel(own);
        fireEvent.keyDown(dialog, { key: 'Escape' });
        yield* Effect.promise(() => waitFor(() => expect(panelIsOpen()).toBe(false)));
        expect(saves.closed.length).toBeGreaterThan(0);
        expect(saves.sent).toEqual([]);
      }),
    );

    it.effect('asks before Escape, the close button and the backdrop drop unsaved changes', () =>
      Effect.gen(function* asks() {
        const { dialog, saves } = yield* openEditPanel(own);
        editDraft();
        const leaveBy = [
          () => fireEvent.keyDown(dialog, { key: 'Escape' }),
          () => fireEvent.click(screen.getByRole('button', { name: 'Zavřít' })),
          () => clickBackdrop(dialog),
        ];
        for (const leave of leaveBy) {
          leave();
          const confirmation = yield* Effect.promise(question);
          expect(panelIsOpen()).toBe(true);
          // The question replaces the old notice: there is one way to keep or drop the draft.
          expect(screen.queryByText('Neuložené změny zůstaly zachované.')).toBeNull();
          fireEvent.click(within(confirmation).getByRole('button', { name: 'Zůstat' }));
          yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()));
          expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveProperty('value', 'Unsaved draft');
        }
        expect(saves).toMatchObject({ closed: [], sent: [] });
      }),
    );

    it.effect('Zahodit změny closes the panel without saving', () =>
      Effect.gen(function* discards() {
        const { dialog, saves } = yield* openEditPanel(own);
        editDraft();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        const confirmation = yield* Effect.promise(question);
        fireEvent.click(within(confirmation).getByRole('button', { name: 'Zahodit změny' }));
        yield* Effect.promise(() => waitFor(() => expect(panelIsOpen()).toBe(false)));
        expect(saves).toMatchObject({ closed: ['closed'], sent: [] });
      }),
    );

    it.effect('Uložit saves once, then closes the panel; a failed save keeps it open', () =>
      Effect.gen(function* saves() {
        const { dialog, saves: sent } = yield* openEditPanel(own);
        const answer = (index: number, outcome: SaveOutcome) => {
          const reply = sent.replies[index];
          expect(reply).toBeDefined();
          if (reply !== undefined) {
            act(() => {
              runtime.runSync(Deferred.succeed(reply, outcome));
            });
          }
        };
        editDraft();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        fireEvent.click(within(yield* Effect.promise(question)).getByRole('button', { name: 'Uložit' }));
        yield* Effect.promise(() => waitFor(() => expect(sent.sent).toEqual(['Unsaved draft'])));
        answer(0, 'failed');
        yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()));
        expect(panelIsOpen()).toBe(true);
        expect(sent.closed).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: 'Zavřít' }));
        fireEvent.click(within(yield* Effect.promise(question)).getByRole('button', { name: 'Uložit' }));
        yield* Effect.promise(() => waitFor(() => expect(sent.sent).toHaveLength(2)));
        expect(panelIsOpen()).toBe(true);
        answer(1, 'saved');
        yield* Effect.promise(() => waitFor(() => expect(panelIsOpen()).toBe(false)));
        expect(sent).toMatchObject({ closed: ['closed'], sent: ['Unsaved draft', 'Unsaved draft'] });
      }),
    );
  });
}

it.effect('renders the save bar of an edit form in the panel footer, after the other actions', () =>
  Effect.gen(function* footer() {
    const { dialog } = yield* openEditPanel(true);
    const bar = dialog.querySelector('[data-save-state]');
    expect(bar).not.toBeNull();
    expect(bar?.parentElement?.lastElementChild).toBe(bar);
    // In the footer, outside the scrolling body, so it stays in view however long the form is.
    expect(screen.getByRole('textbox', { name: 'Draft' }).closest('.overflow-y-auto')?.contains(bar)).toBe(false);
    expect(within(dialog).getAllByRole('button', { name: 'Uložit' })).toHaveLength(1);
    expect(bar?.lastElementChild?.textContent).toBe('Uložit');
    // The form's own close button asks the same guard.
    editDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Zavřít formulář' }));
    yield* Effect.promise(question);
  }),
);
