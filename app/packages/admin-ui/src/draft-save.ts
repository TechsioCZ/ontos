// Explicit save for edit forms: the draft is effect-form state, Uložit is the form's submit and nothing is sent before it.
import { FormAtoms, FormBuilder } from '@lucas-barake/effect-form';
import { Effect, Equal, Exit, Layer, Match, Option, Predicate, Schema } from 'effect';
import { identity } from 'effect/Function';
import type { ManagedRuntime } from 'effect';
import { Atom, AtomRegistry } from 'effect/reactivity';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { SaveRefused } from './save-refused.ts';

/**
 * What the save bar shows. `dirty` is a changed draft that can be saved, `invalid` a changed draft the form's own
 * validation holds back; `proposed` means the draft was accepted for approval and is not saved yet. `ready` is a form
 * that opened with valid values Uložit can send at once (a suggested value) and nothing typed yet: savable, but not
 * unsaved input. `reload-required` is a draft a deploy left behind: the new release refuses this tab until the page
 * reloads, and the draft is still unsaved.
 */
const reloadRequired = 'reload-required';

export const SaveStateSchema = Schema.Literals([
  'idle',
  'ready',
  'dirty',
  'invalid',
  'saving',
  'saved',
  'proposed',
  'error',
  'conflict',
  reloadRequired,
]);
export type SaveState = typeof SaveStateSchema.Type;

/**
 * Result of one save. `conflict` is the action's optimistic-concurrency refusal (the record changed since the
 * revision the draft was based on); `proposed` is a change parked for approval, which saved nothing; every other
 * failure is `failed`.
 */
export const SaveOutcomeSchema = Schema.Literals(['saved', 'proposed', 'conflict', 'failed']);
export type SaveOutcome = typeof SaveOutcomeSchema.Type;

/**
 * A save the new release refused after a deploy, also once the gateway tried to move the tab to it (`releaseGone`
 * of `@app/shared-contracts`): only a page reload loads the new release, and the draft stays unsaved.
 */
export type ReloadRequired = typeof reloadRequired;

/** How one save ended, as the draft form takes it: a `SaveOutcome`, or `reload-required`. */
export const DraftSaveOutcomeSchema = Schema.Union([SaveOutcomeSchema, Schema.Literal(reloadRequired)]);
export type DraftSaveOutcome = typeof DraftSaveOutcomeSchema.Type;

export interface DraftRules<V> {
  /** Whether two drafts are the same. Defaults to structural equality. */
  readonly equals?: (left: V, right: V) => boolean;
  /**
   * The form's own validation; an invalid draft is never sent. `confirmed` is the version the server last confirmed,
   * for a rule that depends on what the save would send, such as a part that is sent whole, and so has to be complete,
   * once it differs from that version. It is read on every render, so it may read more than the draft.
   */
  readonly isValid: (value: V, confirmed: V) => boolean;
}

export interface DraftSaveOptions<V, R> extends DraftRules<V> {
  /**
   * Sends one draft. Map every typed failure to an outcome; a defect or interruption counts as `failed`.
   * Keep the draft's base revision in a ref that `save` reads and updates with the revision the server returns.
   */
  readonly save: (value: V) => Effect.Effect<DraftSaveOutcome, never, R>;
}

/** Statuses in which the draft differs from what the server has confirmed. Live data must not replace it then. */
export const draftPending = (status: SaveState): boolean => status !== 'idle' && status !== 'saved';

/**
 * Statuses in which leaving the form would lose something typed. A draft parked for approval is not one of them:
 * it was handed over and is never sent again.
 */
export const draftUnsaved = (status: SaveState): boolean =>
  draftPending(status) && status !== 'proposed' && status !== 'ready';

/**
 * Statuses in which the Save button sends the draft: a changed, valid draft (typed, or the values the form opened
 * with), or one whose last save failed.
 */
export const draftSavable = (status: SaveState): boolean =>
  status === 'dirty' || status === 'ready' || status === 'error' || status === reloadRequired;

/**
 * Result of a save that knows revisions: the new revision of the record when it was saved, otherwise `proposed`,
 * `conflict` or `failed` (`saved` when the save returns no revision). `proposed` keeps the base revision.
 */
export type RevisionedSaveResult = SaveOutcome | number;

/**
 * Result of a save that sends several commands and stopped part-way: the server took `confirmed` and left it at
 * `revision`, and the rest of the draft ended as `outcome`. The draft stays unsaved. `confirmed` becomes the version
 * later saves are compared with and `revision` their base, so the next save sends only what is still missing, and a
 * field taken back to its value before the save is sent as the change it now is.
 */
export interface PartlySaved<V, Outcome extends Exclude<DraftSaveOutcome, 'saved'> = Exclude<SaveOutcome, 'saved'>> {
  readonly confirmed: V;
  readonly outcome: Outcome;
  readonly revision: number;
}

/** What a draft save answers: a `RevisionedSaveResult`, or how far a save of several commands got. */
export type DraftSaveResult<V> = RevisionedSaveResult | PartlySaved<V>;

/**
 * A `DraftSaveResult`, or a save a deploy left behind (`ReloadRequired`), also after part of it went through: what a
 * record draft's save may answer.
 */
export type DraftSaveEnd<V> = DraftSaveResult<V> | ReloadRequired | PartlySaved<V, Exclude<DraftSaveOutcome, 'saved'>>;

/** What one save of a draft builds on: the version the server last confirmed and the revision it is at. */
interface SaveBase<V> {
  readonly confirmed: V;
  readonly revision: number;
}

/** How one draft form sends its draft and checks it. */
interface DraftFormOptions<V, R> extends DraftRules<V> {
  /** The host's browser runtime; saves run with its services. */
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  readonly save: (value: V, base: SaveBase<V>) => Effect.Effect<DraftSaveEnd<V>, never, R>;
}

/**
 * What one draft form knows besides the draft itself, which is the form's value. A form starts from a server version;
 * taking another one starts its successor (`DraftForm.successor`).
 */
interface Ledger<V> {
  /**
   * What the server last confirmed (the version the generation started from, the draft of the last successful save,
   * or what a save that got part-way wrote), with the revisions made since: what discarding goes back to.
   */
  readonly confirmed: V;
  /** How the last save of this generation ended, while that still describes the draft. */
  readonly ended: Option.Option<{ readonly outcome: DraftSaveOutcome; readonly sent: V }>;
  /**
   * Every draft accepted for approval since the last committed save, exactly as it was sent. None of them is saved,
   * and none is sent again.
   */
  readonly proposed: readonly V[];
  /**
   * The revisions made since the running save started, while one runs: they apply to the version it confirms for
   * discarding, never to what it sent.
   */
  readonly revisedSince: Option.Option<(value: V) => V>;
  /** The revision a save of this form expects; a successful save moves it to the one the server returns. */
  readonly revision: number;
  /** A save of this form runs: its submit is on its way. */
  readonly sending: boolean;
  /** What the server last confirmed, exactly as it was sent. A revision never changes it. */
  readonly server: V;
}

/** The draft and its ledger as one snapshot, which changes whenever either does. */
interface DraftView<V> {
  readonly draft: V;
  readonly ledger: Ledger<V>;
}

const ledgerOf = <V>(confirmed: V, revision: number): Ledger<V> => ({
  confirmed,
  ended: Option.none(),
  proposed: [],
  revisedSince: Option.none(),
  revision,
  sending: false,
  server: confirmed,
});

const sameAs = <V>(rules: DraftRules<V>) => rules.equals ?? Equal.equals;

/**
 * The status of a draft while nothing runs and nothing failed. A draft equal to what the server confirmed is no
 * change, even when what discarding goes back to was revised since.
 */
const restingStatus = <V>(
  rules: DraftRules<V>,
  ledger: Ledger<V>,
  draft: V,
): 'dirty' | 'idle' | 'invalid' | 'proposed' => {
  const same = sameAs(rules);
  if (same(draft, ledger.confirmed) || same(draft, ledger.server)) {
    return 'idle';
  }
  if (ledger.proposed.some((proposed) => same(draft, proposed))) {
    return 'proposed';
  }
  return rules.isValid(draft, ledger.confirmed) ? 'dirty' : 'invalid';
};

/** What the save bar shows for `draft`: the running save, how the last one ended while it still applies, or the rest. */
const statusOf = <V>(rules: DraftRules<V>, ledger: Ledger<V>, draft: V): SaveState => {
  if (ledger.sending) {
    return 'saving';
  }
  const resting = restingStatus(rules, ledger, draft);
  return Option.match(ledger.ended, {
    onNone: (): SaveState => resting,
    onSome: ({ outcome, sent }) =>
      Match.value(outcome).pipe(
        Match.when('saved', (): SaveState => (sameAs(rules)(draft, ledger.confirmed) ? 'saved' : resting)),
        // A conflict holds until the draft is back at the confirmed version or the server version is adopted.
        Match.when('conflict', (): SaveState => (resting === 'idle' ? 'idle' : 'conflict')),
        // The whole tab is behind the release, whatever was typed since: only a reload changes that.
        Match.when(reloadRequired, (): SaveState => (resting === 'idle' ? 'idle' : reloadRequired)),
        // A failure belongs to the draft that was sent.
        Match.when('failed', (): SaveState => (sameAs(rules)(draft, sent) ? 'error' : resting)),
        // A draft parked for approval shows as such while it is on screen.
        Match.when('proposed', (): SaveState => resting),
        Match.exhaustive,
      ),
  });
};

const isUpdate = <V>(action: SetStateAction<V>): action is (previous: V) => V => Predicate.isFunction(action);

/** Saves provide the host runtime's services themselves, so the form's atoms need none. */
const draftAtomRuntime = Atom.runtime(Layer.empty);

/** The draft the form holds, as the form's caller typed it. */
const draftOf = <V>(values: { readonly draft: V }): V => values.draft;

/** One effect-form field holds the whole draft: the form's own fields come with the per-module migration. */
const draftAtoms = <V>(send: (value: V) => Effect.Effect<void, SaveRefused>) =>
  FormAtoms.make({
    formBuilder: FormBuilder.empty.addField('draft', Schema.Any),
    onSubmit: (_args, { encoded }) => send(draftOf<V>(encoded)),
    runtime: draftAtomRuntime,
  });

type DraftAtoms<V> = ReturnType<typeof draftAtoms<V>>;

const isOutcome = Schema.is(DraftSaveOutcomeSchema);

/** A save's answer as the outcome it ended with, the revision it reached and what it wrote, when it got part-way. */
interface SaveEndParts<V> {
  readonly confirmed: Option.Option<V>;
  readonly outcome: DraftSaveOutcome;
  readonly revision: Option.Option<number>;
}

const endOf = <V>(end: DraftSaveEnd<V>): SaveEndParts<V> => {
  if (isOutcome(end)) {
    return { confirmed: Option.none(), outcome: end, revision: Option.none() };
  }
  if (Predicate.isNumber(end)) {
    return { confirmed: Option.none(), outcome: 'saved', revision: Option.some(end) };
  }
  return { confirmed: Option.some(end.confirmed), outcome: end.outcome, revision: Option.some(end.revision) };
};

/**
 * The draft of one edit form as effect-form state, and its explicit save. The draft is the form's value; `save()` is
 * the form's submit, whose `onSubmit` sends the draft once and fails with `SaveRefused` when the server kept nothing,
 * so effect-form's last submit is the last committed save. Nothing is ever sent by itself: no timer, no blur, no
 * unmount. Each form owns its atom registry and starts from one server version; taking another one starts its
 * successor, so a save still running for the form before decides nothing for the draft on screen.
 */
export class DraftForm<V, R = never> {
  private readonly atoms: DraftAtoms<V>;
  /** The forms of one editor: the one on screen takes the calls a form before it still gets (`takeOver`). */
  private readonly forms: { live: DraftForm<V, R> };
  private readonly ledgerAtom: Atom.Writable<Ledger<V>>;
  private options: DraftFormOptions<V, R>;
  private readonly registry = AtomRegistry.make();
  private readonly viewAtom: Atom.Atom<DraftView<V>>;
  /** Callers of `afterSave` that wait for the running save. */
  private readonly waiting = new Set<(status: SaveState, confirmed: V) => void>();

  constructor(
    start: { readonly confirmed: V; readonly revision: number; readonly value: V },
    options: DraftFormOptions<V, R>,
    forms?: { live: DraftForm<V, R> },
  ) {
    this.options = options;
    this.forms = forms ?? { live: this };
    this.atoms = draftAtoms<V>((value) => this.send(value));
    this.ledgerAtom = Atom.make(ledgerOf(start.confirmed, start.revision)).pipe(Atom.keepAlive);
    const { atoms, ledgerAtom } = this;
    this.viewAtom = Atom.readable((get) => {
      const ledger = get(ledgerAtom);
      return {
        draft: Option.match(get(atoms.valuesAtom), { onNone: () => ledger.confirmed, onSome: draftOf<V> }),
        ledger,
      };
    });
    // The form lives as long as this object: its state and its submit stay mounted.
    this.registry.mount(this.viewAtom);
    this.registry.mount(this.atoms.submitAtom);
    this.registry.set(this.atoms.initializeAtom, { draft: start.confirmed });
    if (start.value !== start.confirmed) {
      this.registry.set(this.atoms.setValuesAtom, { draft: start.value });
    }
  }

  /** While the server still has the confirmed version, the base follows newer revisions of it. */
  readonly advance = (revision: number): void => {
    const live = this.live();
    if (live !== this) {
      live.advance(revision);
      return;
    }
    const ledger = this.ledger();
    if (revision > ledger.revision) {
      this.setLedger({ ...ledger, revision });
    }
  };

  /**
   * Runs `done` once the running save has ended, with the status it left and the version it confirmed; at once when
   * no save runs. For whoever started a save and has to act on its result, such as leaving the form after it or
   * starting the next entry from the one just saved.
   */
  readonly afterSave = (done: (status: SaveState, confirmed: V) => void): void => {
    const live = this.live();
    if (live !== this) {
      live.afterSave(done);
      return;
    }
    const ledger = this.ledger();
    if (ledger.sending) {
      this.waiting.add(done);
      return;
    }
    done(this.status(), ledger.confirmed);
  };

  /** The form's current draft. It only moves the status; a changed draft waits for `save()`. */
  readonly change = (value: V): void => {
    const live = this.live();
    if (live !== this) {
      live.change(value);
      return;
    }
    const previous = this.draft();
    if (value === previous) {
      return;
    }
    // An equal draft can still carry newer data its validation reads, such as a product record that finished loading.
    this.registry.set(this.atoms.setValuesAtom, { draft: value });
    const ledger = this.ledger();
    // A running save decides the status when it ends.
    if (this.same(value, previous) || ledger.sending || Option.isNone(ledger.ended)) {
      return;
    }
    // A conflict holds until the draft is back at the confirmed version; so does a release the tab can no longer
    // reach. Any other end of a save describes the draft it sent, which is no longer on screen.
    const { outcome } = ledger.ended.value;
    if ((outcome === 'conflict' || outcome === reloadRequired) && !this.same(value, ledger.confirmed)) {
      return;
    }
    this.setLedger({ ...ledger, ended: Option.none() });
  };

  /** Takes the newest render's rules and save. */
  readonly configure = (options: DraftFormOptions<V, R>): void => {
    this.options = options;
  };

  /**
   * Drops the draft: the form goes back to the confirmed version, without an error or a conflict. A running save
   * still decides the status when it ends.
   */
  readonly discard = (): void => {
    const live = this.live();
    if (live !== this) {
      live.discard();
      return;
    }
    const ledger = this.ledger();
    const state = this.registry.get(this.atoms.stateAtom);
    const submitted = state.pipe(Option.flatMap(({ lastSubmittedValues }) => lastSubmittedValues));
    if (ledger.sending) {
      this.registry.set(this.atoms.setValuesAtom, { draft: ledger.confirmed });
    } else if (Option.exists(submitted, ({ encoded }) => draftOf<V>(encoded) === ledger.confirmed)) {
      // The last successful save is what the server has.
      this.registry.set(this.atoms.revertToLastSubmitAtom, undefined);
    } else if (
      Option.isNone(submitted) &&
      Option.exists(state, ({ initialValues }) => draftOf<V>(initialValues) === ledger.confirmed)
    ) {
      // Nothing was saved: the form opens again with the values it started from.
      this.registry.set(this.atoms.resetAtom, undefined);
    } else {
      this.registry.set(this.atoms.setValuesAtom, { draft: ledger.confirmed });
    }
    if (!ledger.sending) {
      this.setLedger({ ...this.ledger(), ended: Option.none() });
    }
  };

  readonly draft = (): V => this.view().draft;

  /** What a reload has to keep of this form: the unsaved draft with its base, or undefined when nothing is unsaved. */
  readonly kept = (): KeptDraft<V> | undefined => {
    const live = this.live();
    if (live !== this) {
      return live.kept();
    }
    const { confirmed, revision } = this.ledger();
    return draftUnsaved(this.status()) ? { confirmed, revision, value: this.draft() } : undefined;
  };

  readonly ledger = (): Ledger<V> => this.registry.get(this.ledgerAtom);

  /**
   * The form takes something out of what it shows, such as a choice the user has lost access to: `revision` applies
   * to the draft and to the version discarding goes back to, now and when a running save ends. It never applies to
   * what was sent: what the server confirmed, the drafts parked for approval and a running save stay as they went
   * out, so a draft equal to one of them is still not sent again. For the status the revised draft is a change like a
   * typed one.
   */
  readonly revise = (revision: (value: V) => V): void => {
    const live = this.live();
    if (live !== this) {
      live.revise(revision);
      return;
    }
    const ledger = this.ledger();
    this.setLedger({
      ...ledger,
      confirmed: revision(ledger.confirmed),
      revisedSince: ledger.revisedSince.pipe(Option.map((earlier) => (value: V) => revision(earlier(value)))),
    });
    this.change(revision(this.draft()));
  };

  /**
   * The Save button: submits a changed, valid draft once. Does nothing while a save runs, on a conflict, for an
   * unchanged or invalid draft and for a draft already parked for approval. After a failed save it sends the draft
   * again.
   */
  readonly save = (): void => {
    const live = this.live();
    if (live !== this) {
      live.save();
      return;
    }
    const ledger = this.ledger();
    if (
      ledger.sending ||
      this.status() === 'conflict' ||
      restingStatus(this.options, ledger, this.draft()) !== 'dirty'
    ) {
      return;
    }
    this.setLedger({ ...ledger, revisedSince: Option.some(identity<V>), sending: true });
    this.registry.set(this.atoms.submitAtom, undefined);
  };

  /** The status of the current draft under the newest rules. */
  readonly status = (): SaveState => statusOf(this.options, this.ledger(), this.draft());

  /** Calls `listener` whenever the draft or the ledger changes. */
  readonly subscribe = (listener: () => void): (() => void) => this.registry.subscribe(this.viewAtom, listener);

  /** Calls `listener` whenever the ledger changes, for a form whose caller holds the draft it shows. */
  readonly subscribeLedger = (listener: () => void): (() => void) => this.registry.subscribe(this.ledgerAtom, listener);

  /**
   * The form that continues from `confirmed`, a version the server has, with `value` on screen: an unsaved change,
   * error, conflict or running save of this form decides nothing there.
   */
  readonly successor = (confirmed: V, value: V, revision: number): DraftForm<V, R> =>
    new DraftForm({ confirmed, revision, value }, this.options, this.forms);

  /**
   * Starts over from `value`, a server version ("Načíst aktuální verzi", a refused save rebased onto a newer read): the
   * new form is on screen at once, so a draft set right after it in the same handler (`update`, such as the rebased
   * draft) lands on the new form instead of the one it replaces.
   */
  readonly adopt = (value: V, revision: number): DraftForm<V, R> => {
    const next = this.successor(value, value, revision);
    next.takeOver();
    return next;
  };

  /**
   * This form is now the one on screen: a call that still reaches a form before it (a callback created before the
   * editor took a newer server version) lands here.
   */
  readonly takeOver = (): void => {
    this.forms.live = this;
  };

  /** The form's draft set or updated as React state is: an update reads the draft of the form on screen. */
  readonly update = (action: SetStateAction<V>): void => {
    const live = this.live();
    live.change(isUpdate(action) ? action(live.draft()) : action);
  };

  readonly view = (): DraftView<V> => this.registry.get(this.viewAtom);

  /** How the save of `sent` ended; answers everyone who waits for it. */
  private finish(sent: V, end: DraftSaveEnd<V>): DraftSaveOutcome {
    const { confirmed, outcome, revision } = endOf(end);
    const ledger = this.ledger();
    const revisedSince = Option.getOrElse(ledger.revisedSince, () => identity<V>);
    const ended: Ledger<V> = {
      ...ledger,
      // What a save that got part-way wrote is what the server has, with the revisions made while it ran.
      confirmed: Option.match(confirmed, { onNone: () => ledger.confirmed, onSome: revisedSince }),
      ended: Option.some({ outcome, sent }),
      revisedSince: Option.none(),
      revision: Math.max(
        ledger.revision,
        Option.getOrElse(revision, () => ledger.revision),
      ),
      sending: false,
      server: Option.getOrElse(confirmed, () => ledger.server),
    };
    if (outcome === 'saved') {
      // Edits made while this save ran stay an unsaved draft: they wait for the next click. What discarding goes
      // back to is the sent draft, unless the form took part of it out and still shows it so.
      const kept = this.same(this.draft(), sent) ? sent : revisedSince(sent);
      this.setLedger({ ...ended, confirmed: kept, proposed: [], server: sent });
    } else if (outcome === 'proposed') {
      // Parked for approval: the confirmed version stays, and this draft is never sent again.
      const known = ended.proposed.some((proposed) => this.same(sent, proposed));
      this.setLedger({ ...ended, proposed: known ? ended.proposed : [...ended.proposed, sent] });
    } else {
      this.setLedger(ended);
    }
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const done of waiting) {
      done(this.status(), this.ledger().confirmed);
    }
    return outcome;
  }

  private live(): DraftForm<V, R> {
    return this.forms.live;
  }

  private same(left: V, right: V): boolean {
    return sameAs(this.options)(left, right);
  }

  /** The form's submit: sends the draft with the host's services and tells how it ended. */
  private send(value: V): Effect.Effect<void, SaveRefused> {
    const { confirmed, revision } = this.ledger();
    const { runtime, save } = this.options;
    return runtime.contextEffect.pipe(
      Effect.flatMap((context) =>
        Effect.provideContext(
          Effect.suspend(() => save(value, { confirmed, revision })),
          context,
        ),
      ),
      Effect.exit,
      Effect.map((exit): DraftSaveEnd<V> => (Exit.isSuccess(exit) ? exit.value : 'failed')),
      Effect.onInterrupt(() => Effect.sync(() => this.finish(value, 'failed'))),
      Effect.flatMap((end) => {
        const outcome = this.finish(value, end);
        return outcome === 'saved' ? Effect.void : Effect.fail(new SaveRefused({ outcome }));
      }),
    );
  }

  private setLedger(next: Ledger<V>): void {
    this.registry.set(this.ledgerAtom, next);
  }
}

/** What the save bar and the unsaved-changes guard need from a draft, whatever its value is. */
export interface SavableDraft {
  /**
   * Runs `done` once the running save has ended, with the status it left; at once when no save runs. For whoever
   * started a save and has to act on its result, such as leaving the form after it.
   */
  readonly afterSave: (done: (status: SaveState) => void) => void;
  /** The Save button is enabled: the draft is changed and valid, or its last save failed. */
  readonly canSave: boolean;
  /** Leaving the form now would lose something typed (changed, invalid, saving, failed or in conflict). */
  readonly dirty: boolean;
  /** The Save button: sends the whole draft once. Never call it from a change, blur, close or unmount. */
  readonly save: () => void;
  readonly status: SaveState;
}

export interface DraftSave<V> extends SavableDraft {
  /**
   * The form replaced its draft with `value` from the server ("Načíst aktuální verzi", or revalidated data while
   * nothing was pending): the draft starts over from it, dropping an unsaved change, error or conflict.
   */
  readonly adopt: (value: V) => void;
  /** `SavableDraft.afterSave`, also with the version the save left confirmed (`confirmed` after it). */
  readonly afterSave: (done: (status: SaveState, confirmed: V) => void) => void;
  /**
   * The version the server last confirmed, as of this render: what a save compares the draft with, and what
   * discarding the draft goes back to. Field messages that follow the `isValid` rule read it, so they name the same
   * fields the rule holds the draft back for.
   */
  readonly confirmed: V;
  /**
   * The draft differs from the confirmed server state (`dirty`, or parked for approval). While it does, the form
   * keeps its draft and base revision instead of taking revalidated page data.
   */
  readonly pending: boolean;
  /** `DraftForm.revise`: changes every version the draft holds without starting over. */
  readonly revise: (revision: (value: V) => V) => void;
}

export interface UseDraftSaveOptions<V, R> extends DraftRules<V> {
  /**
   * The version the draft starts from, when it is not the first render's draft: a create form passes its empty form,
   * so the values it opens with already count as a draft the Save button sends.
   */
  readonly initial?: V | undefined;
  /**
   * Whether the form is on screen; open by default. A form that stays mounted while closed holds nothing the user
   * can see, so it never counts as unsaved and leaving never asks about it.
   */
  readonly open?: boolean | undefined;
  /**
   * The values the form opens with, when they differ from `initial` (a suggested value Uložit can send at once).
   * They are not typed input: while the draft still equals them and no save of them ran, leaving does not ask.
   */
  readonly opened?: V | undefined;
  /** The host's browser runtime; saves run in it. */
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  /**
   * Sends one draft (see `DraftSaveOptions.save`). A save of several commands that stopped after some of them went
   * through returns `PartlySaved`: its `confirmed` becomes the version later saves and "Zahodit změny" go back to.
   */
  readonly save: (
    value: V,
  ) => Effect.Effect<DraftSaveOutcome | PartlySaved<V, Exclude<DraftSaveOutcome, 'saved'>>, never, R>;
  /** The form's draft. Without `initial`, the first render's value is taken as saved. */
  readonly value: V;
}

const draftSaveOf = <V, R>(
  form: DraftForm<V, R>,
  ledger: Ledger<V>,
  status: SaveState,
  adopt: (value: V) => void,
): DraftSave<V> => ({
  adopt,
  afterSave: form.afterSave,
  canSave: draftSavable(status),
  confirmed: ledger.confirmed,
  dirty: draftUnsaved(status),
  pending: draftPending(status),
  revise: form.revise,
  save: form.save,
  status,
});

/**
 * Explicit save for an edit form whose fields still hold their draft themselves: the hook keeps `value` as the draft of
 * an effect-form form and sends it on `save()` only. To drop the draft, put `confirmed` back into the fields.
 */
export const useDraftSave = <V, R>(options: UseDraftSaveOptions<V, R>): DraftSave<V> => {
  const { value } = options;
  const [form, setForm] = useState(
    () =>
      // `null` is a version too (an empty choice); only an absent `initial` falls back to the first draft.
      new DraftForm(
        { confirmed: Option.getOrElse(Option.fromUndefinedOr(options.initial), () => value), revision: 0, value },
        options,
      ),
  );
  // The newest render's rules and save; the status below reads the same ones.
  form.configure(options);
  // The caller holds the draft it shows: only the ledger re-renders, so a fresh but equal draft every render is fine.
  const ledger = useSyncExternalStore(form.subscribeLedger, form.ledger, form.ledger);
  // This render's draft only moves the status: nothing is sent here, and nothing is sent when the form unmounts.
  useEffect(() => {
    form.takeOver();
    form.change(value);
  }, [form, value]);
  const status = statusOf(options, ledger, value);
  const record = draftSaveOf(form, ledger, status, (next) => {
    setForm(form.adopt(next, 0));
  });
  // Only a changed draft can be untouched: once a save of the opening values ran, its result is the user's.
  const untouched =
    options.opened !== undefined &&
    (status === 'dirty' || status === 'invalid') &&
    sameAs(options)(value, options.opened);
  // Valid opening values are savable but not input: the save bar says nothing about unsaved changes for them.
  const shown: SaveState = untouched && status === 'dirty' ? 'ready' : status;
  return { ...record, dirty: record.dirty && options.open !== false && !untouched, status: shown };
};

/**
 * What a page reload keeps of an unsaved record draft ("Načíst novou verzi a obnovit úpravy"): the draft, the
 * version it is compared with and the revision its save expects, so a change someone else saved in the meantime
 * still ends in a conflict after the reload.
 */
export interface KeptDraft<V> {
  readonly confirmed: V;
  readonly revision: number;
  readonly value: V;
}

export interface UseRecordDraftOptions<V, R> extends DraftRules<V> {
  /**
   * The draft a reload kept for this form (`RecordDraft.kept` before the reload): the form opens with it unsaved,
   * based on its own revision. Read on the first render only.
   */
  readonly kept?: KeptDraft<V> | undefined;
  /** Re-reads the record (e.g. a page-data refresh); `reloadLatest` runs it after dropping the draft. */
  readonly refresh?: Effect.Effect<void, never, R>;
  /**
   * Revision of `server` (often the owner's snapshot revision). A save gets the revision its draft is based on as
   * `expectedRevision`; while the server still has the last confirmed version of this record, the base follows newer
   * revisions, so unrelated changes elsewhere cause no conflict.
   */
  readonly revision?: number;
  /** The host's browser runtime; saves run in it. */
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  /**
   * Sends one draft. Return the record's new revision (or `saved`), `proposed` when the change was parked for
   * approval, `conflict` for the action's revision conflict and `failed` otherwise; a defect or interruption counts
   * as `failed`. A save of several commands that stopped after some of them went through returns `PartlySaved`.
   *
   * `confirmed` is the version the server last confirmed for this draft: the server version the draft started from,
   * then the draft of every successful save (or what a partly successful one wrote). A save that sends only what
   * changed compares the draft with it, never with page data, which still shows the version before that save until
   * its reload lands.
   */
  readonly save: (value: V, expectedRevision: number, confirmed: V) => Effect.Effect<DraftSaveEnd<V>, never, R>;
  /** The record as the server has it now, in the draft's shape (recomputed on every render is fine). */
  readonly server: V;
  /**
   * What a draft with nothing pending becomes when it takes a newer server version; the server version by default.
   * For a field the server does not store, such as a note that goes out with the next save: return the server
   * version with that field of `draft`. The result is a draft over that server version like any typed one.
   */
  readonly takeServer?: (server: V, draft: V) => V;
}

export interface RecordDraft<V> extends DraftSave<V> {
  /**
   * "Zahodit změny": the draft goes back to the confirmed version, without an error or a conflict. When a newer
   * server version arrived while the draft was unsaved, the form continues from that one.
   */
  readonly discard: () => void;
  readonly draft: V;
  /** What a reload has to keep of this form: the unsaved draft with its base, or undefined when nothing is unsaved. */
  readonly kept: () => KeptDraft<V> | undefined;
  /** "Načíst aktuální verzi": drop the draft, continue from the server version and re-read it. */
  readonly reloadLatest: () => void;
  readonly setDraft: Dispatch<SetStateAction<V>>;
}

/**
 * An edit form's draft as effect-form state, with its explicit save. When the server version changes (live
 * revalidation, someone else's save) and nothing is pending, the draft follows it; while something is pending the
 * draft stays, and a save based on an outdated revision ends in `conflict`.
 */
export const useRecordDraft = <V, R>(options: UseRecordDraftOptions<V, R>): RecordDraft<V> => {
  const { kept, refresh, runtime, server } = options;
  const revision = options.revision ?? 0;
  const same = sameAs(options);
  const formOptions: DraftFormOptions<V, R> = {
    ...options,
    save: (value, base) => options.save(value, base.revision, base.confirmed),
  };
  const [form, setForm] = useState(
    () => new DraftForm(kept ?? { confirmed: server, revision, value: server }, formOptions),
  );
  // The newest render's rules and save; the status below reads the same ones.
  form.configure(formOptions);
  const view = useSyncExternalStore(form.subscribe, form.view, form.view);
  const status = statusOf(options, view.ledger, view.draft);
  const { confirmed } = view.ledger;
  const [seen, setSeen] = useState(server);
  // The confirmed version at the moment a newer server version was not taken, because the draft was pending.
  const [passedOver, setPassedOver] = useState<Option.Option<V>>(() => Option.none());
  const settled = !draftPending(status) && same(view.draft, confirmed);
  const takeServerVersion = () => {
    setForm(form.successor(server, options.takeServer?.(server, view.draft) ?? server, revision));
  };
  if (!same(seen, server)) {
    setSeen(server);
    if (settled) {
      setPassedOver(Option.none());
      if (!same(server, view.draft)) {
        takeServerVersion();
      }
    } else if (status === 'proposed' && same(server, view.draft)) {
      // The proposal was approved: the server now has this draft, so it is confirmed from that version on.
      setPassedOver(Option.none());
      setForm(form.successor(server, view.draft, revision));
    } else {
      setPassedOver(Option.some(confirmed));
    }
  } else if (settled && Option.isSome(passedOver)) {
    // The draft is clean again (discarded, or typed back). It takes the version that was passed over, unless a
    // save of this form confirmed a newer one in the meantime: then the page data is the older of the two.
    setPassedOver(Option.none());
    if (same(confirmed, passedOver.value) && !same(server, view.draft)) {
      takeServerVersion();
    }
  }
  useLayoutEffect(() => {
    form.takeOver();
  }, [form]);
  useEffect(() => {
    // The server still has the version this draft builds on: newer revisions changed something else.
    if (same(server, form.ledger().confirmed)) {
      form.advance(revision);
    }
  }, [form, revision, same, server]);
  const adopt = (value: V) => {
    setPassedOver(Option.none());
    setForm(form.adopt(value, revision));
  };
  return {
    ...draftSaveOf(form, view.ledger, status, adopt),
    discard: form.discard,
    draft: view.draft,
    kept: form.kept,
    reloadLatest: () => {
      adopt(seen);
      if (refresh !== undefined) {
        runtime.runFork(refresh);
      }
    },
    setDraft: form.update,
  };
};
