/**
 * Unsaved drafts kept across one page reload of this tab: "Načíst novou verzi a obnovit úpravy". A deploy replaced the
 * release the open document was built from and the operation gateway could not move the tab to the new one
 * (operation-gateway.ts), so only a reload loads it. Every edit form on screen names its draft with a key; the reload
 * writes the drafts the forms report as unsaved to this tab's session storage, and the new document hands each form
 * its own draft back once.
 *
 * The registry and the drafts read back live on `globalThis`, so the separately bundled remotes of one tab share them.
 */

const registryKey = Symbol.for('ontos.kept-drafts.registry');
const restoredKey = Symbol.for('ontos.kept-drafts.restored');
/**
 * Set on `globalThis` right before the reload that keeps the drafts. The unsaved-changes guard of `@app/admin-ui`
 * reads the same symbol and then does not make the browser ask "leave page?": a listener added here at click time
 * runs after the guards' listeners, so it cannot stop their question.
 */
const leavingKey = Symbol.for('ontos.kept-drafts.leaving');
const storagePrefix = 'ontos:kept-drafts:';
/** A kept entry older than this belongs to an earlier visit of the page, not to the reload that wrote it. */
const keptForMillis = 10 * 60 * 1000;

type Snapshot = () => unknown;

interface KeptEntry {
  readonly at: number;
  readonly drafts: Readonly<Record<string, unknown>>;
}

const isKeptEntry = (value: unknown): value is KeptEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'at') === 'number' &&
  typeof Reflect.get(value, 'drafts') === 'object' &&
  Reflect.get(value, 'drafts') !== null;

const globalMap = <V>(key: symbol, fill: (map: Map<string, V>) => void = () => undefined): Map<string, V> => {
  const existing: unknown = Reflect.get(globalThis, key);
  if (existing instanceof Map) {
    return existing;
  }
  const created = new Map<string, V>();
  Reflect.set(globalThis, key, created);
  fill(created);
  return created;
};

const sessionStore = (): Storage | undefined => {
  try {
    return 'sessionStorage' in globalThis ? globalThis.sessionStorage : undefined;
  } catch {
    return undefined;
  }
};

/** One entry per page: a reload comes back to the same path. */
const storageKey = () => `${storagePrefix}${globalThis.location.pathname}`;

/** The forms on screen and how each reports its unsaved draft. */
const registry = () => globalMap<Snapshot>(registryKey);

/** The drafts the reload into this document kept, read from session storage once per document and removed there. */
const restored = () =>
  globalMap<unknown>(restoredKey, (drafts) => {
    const storage = 'location' in globalThis ? sessionStore() : undefined;
    if (storage === undefined) {
      return;
    }
    try {
      const stored = storage.getItem(storageKey());
      storage.removeItem(storageKey());
      const parsed: unknown = stored === null ? null : JSON.parse(stored);
      // @effect-diagnostics-next-line globalDate:off -- A plain browser read at page start; no Effect runtime is involved.
      if (isKeptEntry(parsed) && Date.now() - parsed.at < keptForMillis) {
        for (const [key, draft] of Object.entries(parsed.drafts)) {
          drafts.set(key, draft);
        }
      }
    } catch {
      // Unreadable storage keeps nothing: the forms open with the server version.
    }
  });

/**
 * Keeps `snapshot` as the draft named `key` for a reload that keeps drafts, for as long as the form is on screen.
 * `snapshot` answers the form's unsaved draft, or `undefined` when nothing typed would be lost. Returns how to stop.
 * The form on screen owns its draft from now on: a draft the last reload kept under `key` is not handed out again.
 */
export const keepDraftOnReload = (key: string, snapshot: () => unknown): (() => void) => {
  restored().delete(key);
  const forms = registry();
  forms.set(key, snapshot);
  return () => {
    if (forms.get(key) === snapshot) {
      forms.delete(key);
    }
  };
};

/** Whether the reload into this document kept a draft named `key` that no form has taken yet. */
export const hasKeptDraft = (key: string): boolean => restored().has(key);

/**
 * The draft named `key` that the reload into this document kept, until a form on screen registers its own draft
 * under `key` (`keepDraftOnReload`): a render React throws away hands it out again, a form opened later does not.
 * It is what the form registered under `key` reported before the reload (JSON data); a form merges it over the
 * version it reads now, as a new release may have added fields.
 */
export const keptDraft = <A>(key: string): A | undefined =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The entry was written under this key by the same form before the reload.
  restored().get(key) as A | undefined;

/**
 * "Načíst novou verzi a obnovit úpravy": writes every unsaved draft the forms on screen report to this tab's session
 * storage and reloads the page, which loads the release the Shell serves now. Drafts that cannot be written leave the
 * browser's own question about unsaved changes in place.
 */
export const reloadKeepingDrafts = (): void => {
  const drafts = Object.fromEntries(
    [...registry()].flatMap(([key, snapshot]) => {
      const draft = snapshot();
      return draft === undefined ? [] : [[key, draft] as const];
    }),
  );
  const storage = sessionStore();
  try {
    if (storage !== undefined) {
      // @effect-diagnostics-next-line globalDate:off -- A plain browser write right before the reload; no Effect runtime is involved.
      storage.setItem(storageKey(), JSON.stringify({ at: Date.now(), drafts } satisfies KeptEntry));
      // The reload the user chose keeps the drafts, so the forms' "leave page?" question is not asked.
      Reflect.set(globalThis, leavingKey, true);
    }
  } catch {
    // Full or blocked storage: the browser asks before the reload drops what is typed.
  }
  globalThis.location.reload();
};
