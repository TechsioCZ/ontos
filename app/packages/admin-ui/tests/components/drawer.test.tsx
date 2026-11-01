import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Drawer } from '@techsio/ui-kit/molecules/drawer';
import { afterEach, expect, it } from 'effect-rstest';
import { Effect } from 'effect';

const copy = { closeModeless: 'Close panel', closeNavigation: 'Close navigation' };

afterEach(cleanup);

it.effect('keeps the navigation drawer backdrop clickable while the page is pointer-locked', () =>
  Effect.gen(function* modalBackdrop() {
    render(
      <Drawer defaultOpen placement="start">
        <Drawer.Backdrop />
        <Drawer.Portal>
          <Drawer.Positioner>
            <Drawer.Content>
              <Drawer.Title>Navigation</Drawer.Title>
              <Drawer.CloseTrigger aria-label={copy.closeNavigation} />
            </Drawer.Content>
          </Drawer.Positioner>
        </Drawer.Portal>
      </Drawer>,
    );
    const dialog = yield* Effect.promise(() => screen.findByRole('dialog'));
    yield* Effect.promise(() => waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true)));
    const backdrop = document.querySelector<HTMLElement>('[data-scope="drawer"][data-part="backdrop"]');
    expect(backdrop?.classList.contains('pointer-events-auto')).toBe(true);
    if (backdrop !== null) {
      fireEvent.pointerDown(backdrop, { button: 0, clientX: 600, clientY: 200, pointerType: 'mouse' });
      fireEvent.pointerUp(backdrop, { button: 0, clientX: 600, clientY: 200, pointerType: 'mouse' });
      fireEvent.click(backdrop);
    }
    yield* Effect.promise(() => waitFor(() => expect(dialog.dataset['state']).toBe('closed')));
  }),
);

it.effect('does not force pointer capture onto a modeless drawer backdrop', () =>
  Effect.gen(function* modelessBackdrop() {
    render(
      <Drawer defaultOpen modal={false} placement="end">
        <Drawer.Backdrop />
        <Drawer.Portal>
          <Drawer.Positioner>
            <Drawer.Content>
              <Drawer.Title>Modeless panel</Drawer.Title>
              <Drawer.CloseTrigger aria-label={copy.closeModeless} />
            </Drawer.Content>
          </Drawer.Positioner>
        </Drawer.Portal>
      </Drawer>,
    );
    yield* Effect.promise(() => screen.findByRole('dialog'));
    const backdrop = document.querySelector<HTMLElement>('[data-scope="drawer"][data-part="backdrop"]');
    expect(backdrop?.classList.contains('pointer-events-auto') ?? false).toBe(false);
  }),
);
