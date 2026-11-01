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
