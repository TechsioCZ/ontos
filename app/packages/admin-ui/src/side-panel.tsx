import { ActionIcon } from '@techsio/ui-kit/atoms/action-icon';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Schema } from 'effect';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { isPanelEscape, panelContentId, readEscapeSnapshot } from './side-panel-escape.ts';
import { sidePanelSurfaceClassName } from './ui-kit-classes.ts';
import { useSidePanelResize } from './use-side-panel-resize.ts';

const sidePanelSizeSchema = Schema.Literals(['sm', 'md', 'lg', 'xl']);
export type SidePanelSize = typeof sidePanelSizeSchema.Type;

export interface SidePanelProps {
  /** Footer buttons, primary last (Zrušit, then the submit action). */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  /** Accessible name of the close button. Defaults to `Zavřít`. */
  readonly closeLabel?: string;
  readonly description?: ReactNode;
  readonly finalFocusEl?: () => HTMLElement | null;
  readonly initialFocusEl?: () => HTMLElement | null;
  /** Localized notice shown when a click outside leaves an edited form open. */
  readonly keptDraftLabels?: KeptDraftLabels;
  /**
   * Receives `false` for Escape, the close button and a click outside a form nobody has edited. A click outside an
   * edited form keeps the panel and its draft open instead. Draft owners confirm discard here; the parent owns `open`.
   */
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  /** Localized accessible name and keyboard instructions for the resize handle. */
  readonly resizeLabel: string;
  readonly size?: SidePanelSize;
  readonly title: ReactNode;
}

export interface KeptDraftLabels {
  readonly close: string;
  readonly message: string;
}

const defaultKeptDraftLabels: KeptDraftLabels = {
  close: 'Zavřít bez uložení',
  message: 'Neuložené změny zůstaly zachované.',
};

/** Autosave states in which nothing typed is waiting to be saved; `AutosaveStatus` publishes them. */
const settledAutosaveStates = new Set(['idle', 'saved']);

/** Form fields whose input the panel tracks; search boxes only filter and hold no draft. */
const draftFieldSelector =
  'input:not([type="search"]), textarea, select, [contenteditable="true"], [role="spinbutton"]';

/**
 * Remembers which fields inside the open panel the user changed. A click outside an edited form must not drop the
 * draft, so the panel only treats such a click as a dismissal when no changed field is still on screen (a saved edit
 * form usually unmounts) or every autosave status in the panel is settled. Escape keeps closing as before.
 */
const useEditedDraft = (open: boolean, contentId: string) => {
  const edited = useRef(new Set<EventTarget>());
  const lastIntent = useRef<'escape' | 'other'>('other');
  const lastFocused = useRef<EventTarget | null>(null);
  useEffect(() => {
    edited.current.clear();
    const doc = globalThis.document;
    const onEdit = (event: Event) => {
      const content = doc.querySelector(`[id="${contentId}"]`);
      const { target } = event;
      if (content !== null && target !== null && event.composedPath().includes(content)) {
        edited.current.add(target);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const content = doc.querySelector(`[id="${contentId}"]`);
      if (content !== null && event.composedPath().includes(content)) {
        lastFocused.current = event.target;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      lastIntent.current = event.key === 'Escape' ? 'escape' : 'other';
    };
    const onPointerDown = () => {
      lastIntent.current = 'other';
    };
    // A closed panel listens to nothing; removing listeners that were never added is harmless.
    if (open) {
      doc.addEventListener('input', onEdit, true);
      doc.addEventListener('change', onEdit, true);
      doc.addEventListener('focusin', onFocusIn, true);
      globalThis.addEventListener('keydown', onKeyDown, { capture: true });
      globalThis.addEventListener('pointerdown', onPointerDown, { capture: true });
    }
    return () => {
      doc.removeEventListener('input', onEdit, true);
      doc.removeEventListener('change', onEdit, true);
      doc.removeEventListener('focusin', onFocusIn, true);
      globalThis.removeEventListener('keydown', onKeyDown, { capture: true });
      globalThis.removeEventListener('pointerdown', onPointerDown, { capture: true });
    };
  }, [contentId, open]);

  /** True when a ui-kit dismissal is a click or focus move outside an edited form, not an Escape. */
  const keepsDraft = (): boolean => {
    if (lastIntent.current === 'escape') {
      return false;
    }
    const content = globalThis.document.querySelector(`[id="${contentId}"]`);
    if (content === null) {
      return false;
    }
    const autosave = [...content.querySelectorAll<HTMLElement>('[data-autosave-state]')];
    if (
      autosave.length > 0 &&
      autosave.every((status) => settledAutosaveStates.has(status.dataset['autosaveState'] ?? ''))
    ) {
      return false;
    }
    return [...content.querySelectorAll(draftFieldSelector)].some((field) => edited.current.has(field));
  };

  /** The outside press moved focus out of the kept panel; put it back on the field the user was in. */
  const refocusDraft = (): void => {
    globalThis.requestAnimationFrame(() => {
      const content = globalThis.document.querySelector(`[id="${contentId}"]`);
      const focusable =
        content?.querySelectorAll<HTMLElement>(`${draftFieldSelector}, button, a[href], [tabindex]`) ?? [];
      [...focusable].find((candidate) => candidate === lastFocused.current)?.focus();
    });
  };
  return { keepsDraft, refocusDraft };
};

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
 * Czech, sizes the title like a SectionCard heading, flattens SectionCards inside it (the panel
 * edge is the one outline), and closes on Escape whenever no listbox, calendar, menu or nested
 * dialog is open above it.
 */
export const SidePanel = ({
  actions,
  children,
  className,
  closeLabel = 'Zavřít',
  description,
  finalFocusEl,
  initialFocusEl,
  keptDraftLabels = defaultKeptDraftLabels,
  onOpenChange,
  open,
  resizeLabel,
  size = 'md',
  title,
}: SidePanelProps) => {
  const id = useId();
  const resize = useSidePanelResize();
  useEscapeFallback(open, panelContentId(id), onOpenChange);
  const { keepsDraft, refocusDraft } = useEditedDraft(open, panelContentId(id));
  const [draftKept, setDraftKept] = useState(false);
  const [shownOpen, setShownOpen] = useState(open);
  if (shownOpen !== open) {
    // A reopened panel starts without the previous session's notice.
    setShownOpen(open);
    setDraftKept(false);
  }

  return (
    <Dialog
      className={`min-w-0 sm:min-w-(--container-dialog-sm) ${sidePanelSurfaceClassName} ${className ?? ''}`}
      {...(finalFocusEl === undefined ? {} : { finalFocusEl })}
      {...(initialFocusEl === undefined ? {} : { initialFocusEl })}
      actions={actions}
      closeOnInteractOutside
      contentRef={resize.contentRef}
      contentStyle={{ maxWidth: '100vw', width: resize.width }}
      customTrigger
      description={description}
      hideCloseButton
      id={id}
      onOpenChange={(details) => {
        if (!details.open && keepsDraft()) {
          setDraftKept(true);
          refocusDraft();
          return;
        }
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
      <ActionIcon
        {...resize.handleProps}
        aria-controls={panelContentId(id)}
        aria-label={resizeLabel}
        className="absolute inset-y-0 left-0 hidden h-full w-200 touch-none cursor-col-resize select-none rounded-none sm:flex"
        icon="icon-[mdi--drag-vertical]"
        size="sm"
        tone="neutral"
      />
      {/* Above the scrolling body, so the notice stays visible however far the form is scrolled. */}
      {draftKept && (
        <div className="flex flex-wrap items-center gap-100">
          <StatusText showIcon size="sm" status="warning">
            {keptDraftLabels.message}
          </StatusText>
          <Button onClick={() => onOpenChange(false)} size="sm" theme="borderless" variant="secondary">
            {keptDraftLabels.close}
          </Button>
        </div>
      )}
      {/* The body scrolls on its own, so the footer actions stay visible at the bottom of a tall panel. The
          inline padding pair keeps focus rings from being clipped by the scroll edge. */}
      <div className="-mx-100 flex min-h-0 flex-1 flex-col gap-dialog-content overflow-y-auto px-100">{children}</div>
    </Dialog>
  );
};
