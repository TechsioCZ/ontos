import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Drawer } from '@techsio/ui-kit/molecules/drawer';
import { afterEach, expect, it } from 'effect-rstest';
import { Effect } from 'effect';

const copy = { closeModeless: 'Close panel', closeNavigation: 'Close navigation' };

afterEach(cleanup);

it.effect('keeps the navigation drawer backdrop clickable while the page is pointer-locked', () =>
  Effect.gen(function* drawerBackdrop() {
    render(
      <Drawer>
        <Drawer.Trigger>Open navigation</Drawer.Trigger>
        <Drawer.Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content>
              <Drawer.Title>Navigation</Drawer.Title>
              <Drawer.CloseTrigger aria-label={copy.closeNavigation} />
            </Drawer.Content>
          </Drawer.Positioner>
        </Drawer.Portal>
      </Drawer>,
    );
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Navigation' }));
    yield* Effect.promise(() => waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true)));
    const backdrop = document.querySelector<HTMLElement>('[data-scope="drawer"][data-part="backdrop"]');
    expect(backdrop?.classList.contains('pointer-events-auto')).toBe(true);
    expect(document.body.style.pointerEvents).toBe('none');
    if (backdrop !== null) {
      fireEvent.pointerDown(backdrop, { button: 0, clientX: 0, clientY: 0, pointerType: 'mouse' });
      fireEvent.pointerUp(backdrop, { button: 0, clientX: 0, clientY: 0, pointerType: 'mouse' });
      fireEvent.click(backdrop);
    }
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()));
    yield* Effect.promise(() => waitFor(() => expect(document.activeElement).toBe(trigger)));
    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.pointerEvents).toBe('');
  }),
);

it.effect('does not force pointer capture onto a modeless drawer backdrop', () =>
  Effect.gen(function* modelessDrawer() {
    render(
      <Drawer defaultOpen modal={false}>
        <Drawer.Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content>
              <Drawer.Title>Modeless panel</Drawer.Title>
              <Drawer.CloseTrigger aria-label={copy.closeModeless} />
            </Drawer.Content>
          </Drawer.Positioner>
        </Drawer.Portal>
      </Drawer>,
    );
    yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Modeless panel' }));
    const backdrop = document.querySelector<HTMLElement>('[data-scope="drawer"][data-part="backdrop"]');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.classList.contains('pointer-events-auto')).toBe(false);
    expect(document.body.style.pointerEvents).toBe('');
  }),
);
