// The one guard of unsaved changes: whoever is about to leave an edit form asks it first.
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { constVoid } from 'effect/Function';
import { createContext, use, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { SavableDraft, SaveState } from './draft-save.ts';
import { saveLabels } from './save-labels.ts';
import type { SaveLabels } from './save-labels.ts';
import { dialogCloseLabel } from './ui-kit-labels.ts';

/**
 * A router's blocked navigation, as TanStack's `useBlocker({ withResolver: true })` returns it. The guard asks its
 * question while `status` is `blocked`, then calls `proceed` or `reset`.
 */
export interface BlockedNavigation {
  readonly proceed?: (() => void) | undefined;
  readonly reset?: (() => void) | undefined;
  readonly status: 'blocked' | 'idle';
}

export interface UnsavedChangesGuardOptions {
  /** The draft of the form (`useRecordDraft`, `useDraftSave`): whether it is unsaved, and how to save it. */
  readonly draft: SavableDraft;
  /** Route navigation blocked by the router while the guard is `dirty`; browser Back and links then ask too. */
  readonly navigation?: BlockedNavigation | undefined;
  /** "Zahodit změny": put the confirmed version back on screen (`RecordDraft.discard`). */
  readonly onDiscard: () => void;
  /**
   * Other unsaved input of the same screen that Save does not send, such as a half-filled form of another command.
   * It blocks leaving like the draft does; after a save the question stays until it is discarded or kept.
   */
  readonly otherChanges?: boolean;
}

/** What `UnsavedChangesDialog` renders; produced by `useUnsavedChangesGuard`. */
export interface UnsavedChangesPrompt {
  readonly canSave: boolean;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
  readonly onStay: () => void;
  readonly open: boolean;
  readonly saving: boolean;
}

type LeaveRequest = (leave: () => void) => void;

export interface UnsavedChangesGuard {
  /** Something typed would be lost by leaving now. */
  readonly dirty: boolean;
  /** Props of the one `UnsavedChangesDialog` the form renders. */
  readonly prompt: UnsavedChangesPrompt;
  /**
   * Leave through the guard: `leave` runs at once when nothing is unsaved; otherwise the confirmation asks first and
   * `leave` runs after Uložit succeeded or after Zahodit změny. Zůstat, a failed save and a conflict keep the form.
   */
  readonly request: LeaveRequest;
}

/** The guards of the drafts shown inside one boundary, such as a side panel or a page with a record list. */
export interface UnsavedChangesScope {
  /** Whether a guard is registered: the scope's drafts are then left through `request` only. */
  readonly guarded: () => boolean;
  /** Adds a guard for as long as its form is on screen; returns how to remove it. */
  readonly register: (request: LeaveRequest) => () => void;
  /** Leave through every guard of the scope, one question at a time. */
  readonly request: LeaveRequest;
}

/** Outside every boundary: nobody else asks the guard. */
const noScope: UnsavedChangesScope = {
  guarded: () => false,
  register: () => constVoid,
  request: (leave) => {
    leave();
  },
};

const ScopeContext = createContext<UnsavedChangesScope | null>(null);

/**
 * A scope for a screen that shows drafts and can leave them without unmounting through a guard of its own, for
 * example a list whose row click swaps the record in an open editor: call `scope.request(() => select(row))`.
 * Hand the scope to `UnsavedChangesBoundary` around the editors. A `SidePanel` is such a boundary by itself.
 */
export const useUnsavedChangesScope = (): UnsavedChangesScope => {
  const guards = useRef(new Set<LeaveRequest>());
  return {
    guarded: () => guards.current.size > 0,
    register: (request) => {
      guards.current.add(request);
      return () => {
        guards.current.delete(request);
      };
    },
    request: (leave) => {
      // Each guard leaves into the next one; the last leaves for real.
      let through = leave;
      for (const request of guards.current) {
        const next = through;
        through = () => {
          request(next);
        };
      }
      through();
    },
  };
};

/** The scope an enclosing boundary provides, or the given one when there is none. */
export const useEnclosingScope = (fallback: UnsavedChangesScope): UnsavedChangesScope => use(ScopeContext) ?? fallback;

export const UnsavedChangesBoundary = ({
  children,
  scope,
}: {
  readonly children?: ReactNode;
  readonly scope: UnsavedChangesScope;
}) => <ScopeContext value={scope}>{children}</ScopeContext>;

/** A leave that waits for an answer; a blocked navigation has none of its own, the router holds it. */
interface Asked {
  readonly leave: () => void;
}

/** How the save Uložit started ended: `leave` when the draft is safe, `stay` when it is not. */
const saveEndOf = (status: SaveState, otherChanges: boolean): 'ask-again' | 'leave' | 'stay' => {
  if (status !== 'idle' && status !== 'saved' && status !== 'proposed') {
    return 'stay';
  }
  return otherChanges ? 'ask-again' : 'leave';
};

/**
 * The guard of one edit form. Route every way out of the form through `request` (the Close button, the panel's
 * dismissal, switching record), pass a blocked router navigation as `navigation`, and render one
 * `UnsavedChangesDialog` with `prompt`. Closing the browser tab asks through the browser's own prompt. Nothing is
 * ever saved without the user choosing Uložit.
 *
 * Inside a `SidePanel` (or another `UnsavedChangesBoundary`) the guard is asked by that boundary on its own. A
 * component that renders its `SidePanel` itself passes the guard as the panel's `guard` prop instead.
 */
export const useUnsavedChangesGuard = ({
  draft,
  navigation,
  onDiscard,
  otherChanges = false,
}: UnsavedChangesGuardOptions): UnsavedChangesGuard => {
  const dirty = draft.dirty || otherChanges;
  const [asked, setAsked] = useState<Asked | null>(null);
  const [saving, setSaving] = useState(false);
  // A blocked navigation is a leave the router holds: it is asked about like a requested one.
  const blocked = navigation?.status === 'blocked';
  const leave = blocked ? navigation.proceed : asked?.leave;
  const stay = () => {
    setAsked(null);
    if (blocked) {
      navigation.reset?.();
    }
  };

  // Closing or reloading the tab: the browser asks with its own prompt.
  useEffect(() => {
    const ask = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
      }
    };
    globalThis.addEventListener('beforeunload', ask);
    return () => {
      globalThis.removeEventListener('beforeunload', ask);
    };
  }, [dirty]);

  // A second way out while the question is up does not replace the first.
  const ask = (next: () => void) => {
    setAsked((current) => current ?? { leave: next });
  };
  const request: LeaveRequest = (next) => {
    if (dirty) {
      ask(next);
      return;
    }
    next();
  };
  // The enclosing boundary asks this guard for as long as the form is on screen, with the draft as it is then.
  const unsaved = useRef(dirty);
  useEffect(() => {
    unsaved.current = dirty;
  }, [dirty]);
  const scope = use(ScopeContext) ?? noScope;
  useEffect(
    () =>
      scope.register((next) => {
        if (unsaved.current) {
          setAsked((current) => current ?? { leave: next });
          return;
        }
        next();
      }),
    [scope],
  );

  return {
    dirty,
    prompt: {
      canSave: draft.canSave,
      onDiscard: () => {
        setAsked(null);
        onDiscard();
        leave?.();
      },
      onSave: () => {
        setSaving(true);
        draft.save();
        // A safe draft leaves; a failed save, a conflict or an invalid draft keeps the form, whose save bar says
        // why. Unsaved input the save does not cover keeps the question up.
        draft.afterSave((status) => {
          setSaving(false);
          const end = saveEndOf(status, otherChanges);
          if (end === 'ask-again') {
            return;
          }
          if (end === 'stay') {
            stay();
            return;
          }
          setAsked(null);
          leave?.();
        });
      },
      onStay: stay,
      open: blocked || asked !== null,
      saving,
    },
    request,
  };
};

export interface UnsavedChangesDialogProps {
  /** Wording for the current language (`saveLabelsFor(language)`); Czech by default. */
  readonly labels?: SaveLabels;
  readonly prompt: UnsavedChangesPrompt;
}

/**
 * The question asked before unsaved changes are left: Uložit, Zahodit změny or Zůstat. Escape and a click outside
 * mean Zůstat.
 */
export const UnsavedChangesDialog = ({ labels = saveLabels, prompt }: UnsavedChangesDialogProps) => {
  const handleDiscard = prompt.onDiscard;
  const handleSave = prompt.onSave;
  const handleStay = prompt.onStay;
  return (
    <Dialog
      actions={
        // One row from the small breakpoint up: Uložit never drops below Zůstat / Zahodit změny on a desktop.
        <div className="flex w-full flex-wrap justify-end gap-100 sm:flex-nowrap" data-leave-actions="">
          <Button className="whitespace-nowrap" onClick={handleStay} theme="outlined" type="button" variant="secondary">
            {labels.stay}
          </Button>
          <Button className="whitespace-nowrap" onClick={handleDiscard} theme="outlined" type="button" variant="danger">
            {labels.discard}
          </Button>
          <Button
            className="whitespace-nowrap"
            disabled={!(prompt.canSave || prompt.saving)}
            isLoading={prompt.saving}
            loadingText={labels.saving}
            onClick={handleSave}
            type="button"
            variant="primary"
          >
            {labels.save}
          </Button>
        </div>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={labels.leaveDescription}
      onOpenChange={({ open }) => {
        if (!open) {
          handleStay();
        }
      }}
      open={prompt.open}
      role="alertdialog"
      // `sm` (24rem) is too narrow for the three buttons side by side.
      size="md"
      title={labels.leaveTitle}
    />
  );
};
