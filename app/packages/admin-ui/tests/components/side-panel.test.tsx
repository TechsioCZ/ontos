import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { afterEach, expect, it } from 'effect-rstest';
import { Effect } from 'effect';
import { useState } from 'react';
import { SidePanel } from '../../src/side-panel.tsx';

const copy = { confirmation: 'Confirm discard', title: 'Panel details' };

/** A panel owner like the demo's draft forms: a guarded owner asks before an edited draft is dropped. */
const PanelExample = ({
  autosaved = false,
  guarded = false,
}: {
  readonly autosaved?: boolean;
  readonly guarded?: boolean;
}) => {
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
        {autosaved && <div data-autosave-state={dirty ? 'saved' : 'idle'} />}
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

const openPanel = Effect.fn('openPanel')(function* openPanel(guarded = false, autosaved = false) {
  render(<PanelExample autosaved={autosaved} guarded={guarded} />);
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

it.effect('lets a settled autosave form close from the backdrop', () =>
  Effect.gen(function* autosavedClose() {
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

/** Same selector as the `.ontos-side-peek` stop-gap rule in apps/shell-super-app/src/routes/ui-kit.css. */
const peekBackdropSelector =
  "[data-scope='dialog'][data-part='backdrop']:has(+ [data-scope='dialog'][data-part='positioner'] > .ontos-side-peek)";

const openPeek = Effect.fn('openPeek')(function* openPeek(onRowClick: () => void) {
  render(<PeekExample onRowClick={onRowClick} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open row' }));
  const dialog = yield* Effect.promise(() => screen.findByRole('dialog', { name: copy.title }));
  return dialog;
});

it.effect('keeps the default panel modal and unmarked', () =>
  Effect.gen(function* defaultPanel() {
    const { dialog } = yield* openPanel();
    expect(dialog.classList.contains('ontos-side-peek')).toBe(false);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.parentElement?.classList.contains('pointer-events-auto')).toBe(true);
  }),
);

it.effect('renders a peek panel with the marker class and the DOM the backdrop selector relies on', () =>
  Effect.gen(function* peekDom() {
    const dialog = yield* openPeek(() => {});
    expect(dialog.classList.contains('ontos-side-peek')).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    const positioner = dialog.parentElement;
    expect(positioner?.dataset['part']).toBe('positioner');
    // The backdrop is the element right before the positioner, and the marked content sits directly inside it.
    const backdrop = document.querySelector<HTMLElement>(peekBackdropSelector);
    expect(backdrop?.dataset['scope']).toBe('dialog');
    expect(backdrop?.dataset['part']).toBe('backdrop');
    expect(backdrop?.nextElementSibling).toBe(positioner);
    expect(positioner?.querySelector(':scope > .ontos-side-peek')).toBe(dialog);
    expect(document.querySelectorAll(peekBackdropSelector)).toHaveLength(1);
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
