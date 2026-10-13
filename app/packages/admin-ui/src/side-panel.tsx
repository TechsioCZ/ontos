import { ActionIcon } from '@techsio/ui-kit/atoms/action-icon';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Schema } from 'effect';
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { isPanelEscape, panelContentId, readEscapeSnapshot } from './side-panel-escape.ts';

const sidePanelSizeSchema = Schema.Literals(['sm', 'md', 'lg', 'xl']);
export type SidePanelSize = typeof sidePanelSizeSchema.Type;

export interface SidePanelProps {
  /** Footer buttons, primary last (Zrušit, then the submit action). */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  /** Accessible name of the close button. Defaults to `Zavřít`. */
  readonly closeLabel?: string;
  /**
   * Defaults to true. Panels that hold an unsaved draft pass false, so a stray click or focus move
   * outside keeps the draft. Escape, the close button and Zrušit still close the panel.
   */
  readonly closeOnInteractOutside?: boolean;
  readonly description?: ReactNode;
  readonly finalFocusEl?: () => HTMLElement | null;
  readonly initialFocusEl?: () => HTMLElement | null;
  /** Receives `false` on Escape, the close button or an outside click. The parent owns `open`. */
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly size?: SidePanelSize;
  readonly title: ReactNode;
}

/**
 * Closes the panel on an Escape that no layer above it owns, even when zag's own layer stack
 * missed it. Reads the DOM in the window capture phase, before any layer handles the key, then
 * waits one animation frame so zag and React finish this Escape first. A panel they already closed
 * is left alone.
 */
const useEscapeFallback = (open: boolean, contentId: string, onOpenChange: (open: boolean) => void): void => {
  const latest = useRef({ onOpenChange, open });
  useEffect(() => {
    latest.current = { onOpenChange, open };
  }, [onOpenChange, open]);

  useEffect(() => {
    const doc = globalThis.document;
    const frames = new Set<number>();
    const closeIfStillOpen = (frame: number) => {
      frames.delete(frame);
      const content = doc.querySelector<HTMLElement>(`[id="${contentId}"]`);
      if (latest.current.open && content?.dataset['state'] === 'open') {
        latest.current.onOpenChange(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!latest.current.open || !isPanelEscape(readEscapeSnapshot(event, doc), contentId)) {
        return;
      }
      const frame: number = globalThis.requestAnimationFrame(() => {
        closeIfStillOpen(frame);
      });
      frames.add(frame);
    };
    globalThis.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown, { capture: true });
      for (const frame of frames) {
        globalThis.cancelAnimationFrame(frame);
      }
    };
  }, [contentId]);
};

/**
 * Right-hand side panel for create, edit and quick-view forms. Wraps ui-kit `Dialog` with
 * `placement="right"`, never renders the stray default "Open" trigger, labels its close button in
 * Czech, sizes the title like a SectionCard heading, and closes on Escape
 * whenever no listbox, calendar, menu or nested dialog is open above it.
 */
export const SidePanel = ({
  actions,
  children,
  className,
  closeLabel = 'Zavřít',
  closeOnInteractOutside = true,
  description,
  finalFocusEl,
  initialFocusEl,
  onOpenChange,
  open,
  size = 'md',
  title,
}: SidePanelProps) => {
  const id = useId();
  useEscapeFallback(open, panelContentId(id), onOpenChange);

  return (
    <Dialog
      {...(className === undefined ? {} : { className })}
      {...(finalFocusEl === undefined ? {} : { finalFocusEl })}
      {...(initialFocusEl === undefined ? {} : { initialFocusEl })}
      actions={actions}
      closeOnInteractOutside={closeOnInteractOutside}
      customTrigger
      description={description}
      hideCloseButton
      id={id}
      onOpenChange={(details) => {
        onOpenChange(details.open);
      }}
      open={open}
      placement="right"
      size={size}
      title={<span className="font-semibold text-md">{title}</span>}
    >
      {/* ui-kit hard-codes the English "Close dialog" label, so the panel renders its own close button. */}
      <ActionIcon
        aria-label={closeLabel}
        className="absolute end-dialog-close-trigger-offset top-dialog-close-trigger-offset"
        icon="token-icon-dialog-close"
        onClick={() => {
          onOpenChange(false);
        }}
        size="md"
        tone="neutral"
      />
      {/* The body scrolls on its own, so the footer actions stay visible at the bottom of a tall panel. The
          inline padding pair keeps focus rings from being clipped by the scroll edge. */}
      <div className="-mx-100 flex min-h-0 flex-1 flex-col gap-dialog-content overflow-y-auto px-100">{children}</div>
    </Dialog>
  );
};
