// The asset card edit autosave against the agenda revision: a settled draft follows a fresh read of its record, while
// a draft the user is still editing keeps the revision it was built on, so a change to that record refuses the save
// instead of silently overwriting it. The hook is a thin wrapper over `assetCardRefreshOf` and `assetCardAutosaveOf`;
// this drives those real decisions with the real AutosaveController, exactly as the panel wires them.
import { autosavePending, startAutosave } from '@app/admin-ui';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { OpsCommand } from '../../shared/agendas.ts';
import { AssetSchema } from '../../shared/domain/assets.ts';
import type { Asset } from '../../shared/domain/assets.ts';
import { touchedSince } from '../../shared/domain/change-log.ts';
import {
  assetCardAutosaveOf,
  assetCardBaseOf,
  assetCardRefreshOf,
} from '../../src/routes/[lang]/provoz/majetek/asset-card-autosave.ts';
import type { AssetCardBase, RunAssetCommand } from '../../src/routes/[lang]/provoz/majetek/asset-card-autosave.ts';
import { assetCardDraftOf, assetCardUpdateCommandOf } from '../../src/routes/[lang]/provoz/majetek/asset-card-draft.ts';
import type { AssetCardDraft } from '../../src/routes/[lang]/provoz/majetek/asset-card-draft.ts';
import { assetPlacementOf } from '../../src/routes/[lang]/provoz/majetek/property-tree.ts';
import type { CommandOutcome } from '../../src/ui/use-agenda.ts';

const assetId = 'asset-1';
const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const at = '2026-10-20T08:00:00Z';
const later = '2026-10-21T09:30:00Z';
const property = { id: 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b', kind: 'property', label: 'Rezidence Parková' } as const;

const assetOf = (fields: {
  readonly id?: string;
  readonly name?: string;
  readonly note?: string;
  readonly updatedAt: string;
}): Asset =>
  Schema.decodeUnknownSync(AssetSchema)({
    acquisitionDate: '2024-03-01',
    category: 'Klimatizace',
    createdAt: at,
    createdBy: actor,
    id: fields.id ?? assetId,
    inventoryNumber: 'MJ-2024-017',
    kind: 'equipment',
    location: property,
    name: fields.name ?? 'Venkovní jednotka',
    note: fields.note ?? 'Střešní instalace',
    propertyId: property.id,
    responsible: 'Jan Novák',
    serialNumber: 'KL-8831',
    updatedAt: fields.updatedAt,
    updatedBy: actor,
  });

const opened = assetOf({ updatedAt: at });
const stored = assetCardDraftOf(opened);
const openedAt = DateTime.formatIso(opened.updatedAt);

/** One page read of the assets agenda: the revision and envelope instant a runner of that read sends. */
const AgendaSnapshotSchema = Schema.Struct({
  revision: Schema.Int,
  updatedAt: Schema.DateTimeUtcFromString,
});
type AgendaSnapshot = typeof AgendaSnapshotSchema.Type;

const snapshotOf = (revision: number, updatedAt: string): AgendaSnapshot =>
  Schema.decodeUnknownSync(AgendaSnapshotSchema)({ revision, updatedAt });

/** The assets agenda row behind the fake page runner: its revision and the instant of the record it changes. */
interface AgendaServer {
  readonly applied: { readonly command: OpsCommand; readonly expectedRevision: number }[];
  recordUpdatedAt: DateTime.Utc;
  revision: number;
}

const serverOf = (revision: number, recordUpdatedAt: string): AgendaServer => ({
  applied: [],
  recordUpdatedAt: DateTime.makeUnsafe(recordUpdatedAt),
  revision,
});

/**
 * The page runner of one read: it sends that read's revision and instant, exactly like the page's `useAgendaRecords`,
 * and applies the agenda's own rule — a stale revision is refused when the record the command changes was itself
 * changed after that instant, and otherwise re-applied to the current state.
 */
const runnerOf =
  (server: AgendaServer, snapshot: AgendaSnapshot): RunAssetCommand =>
  (command: OpsCommand) =>
    Effect.sync((): CommandOutcome => {
      server.applied.push({ command, expectedRevision: snapshot.revision });
      const touched =
        server.revision !== snapshot.revision &&
        touchedSince(
          { assets: [{ id: assetId, updatedAt: DateTime.formatIso(server.recordUpdatedAt) }] },
          [assetId],
          DateTime.formatIso(snapshot.updatedAt),
        );
      if (touched) {
        return { ok: false, reason: 'conflict' };
      }
      server.revision += 1;
      return { ok: true, result: { entityIds: [], revision: server.revision } };
    });

type AssetUpdateCommand = Extract<OpsCommand, { readonly _tag: 'AssetUpdate' }>;

/** The update command in a sent command, when the panel sent one (a `Match` over the Schema-owned tags). */
const updateOf = (command: OpsCommand | undefined): Option.Option<AssetUpdateCommand> =>
  command === undefined
    ? Option.none()
    : Match.value(command).pipe(
        Match.tag('AssetUpdate', (value): Option.Option<AssetUpdateCommand> => Option.some(value)),
        Match.orElse((): Option.Option<AssetUpdateCommand> => Option.none()),
      );

const openPanel = Effect.fnUntraced(function* openPanel(
  server: AgendaServer,
  first: { readonly asset: Asset; readonly snapshot: AgendaSnapshot },
) {
  const { asset: firstAsset, snapshot: firstSnapshot } = first;
  let asset = firstAsset;
  let run = runnerOf(server, firstSnapshot);
  let seen = firstAsset;
  let base: AssetCardBase = assetCardBaseOf(run, firstAsset);
  let draft = assetCardDraftOf(firstAsset);
  const options = () =>
    assetCardAutosaveOf({
      base: () => base,
      commandOf: (value: AssetCardDraft) =>
        assetCardUpdateCommandOf(value, asset, assetPlacementOf({ status: 'loading' }, value, asset)),
    });
  let controller = yield* startAutosave(draft, options());
  /** The hook's `adopt`: a fresh controller (and draft) from the version being adopted. */
  const restart = (value: AssetCardDraft) =>
    Effect.gen(function* restarting() {
      controller.dispose();
      draft = value;
      controller = yield* startAutosave(value, options());
    });
  /** One render with a fresh page read: the hook's own render-phase refresh decision. */
  const render = (next: { readonly asset: Asset; readonly snapshot: AgendaSnapshot }) =>
    Effect.gen(function* rendering() {
      if (seen === next.asset) {
        return;
      }
      seen = next.asset;
      run = runnerOf(server, next.snapshot);
      const refresh = assetCardRefreshOf({
        asset: next.asset,
        base,
        draft,
        pending: autosavePending(controller.status()),
        run,
      });
      ({ base } = refresh);
      ({ asset } = next);
      if (refresh.adopt !== null) {
        yield* restart(refresh.adopt);
      }
    });
  return {
    base: () => base,
    draft: () => draft,
    flush: () => controller.flush(),
    reloadLatest: () =>
      Effect.gen(function* reloading() {
        base = assetCardBaseOf(run, asset);
        yield* restart(assetCardDraftOf(asset));
      }),
    render,
    status: () => controller.status(),
    type: (value: AssetCardDraft) => {
      draft = value;
      controller.change(value);
    },
  };
});

describe('asset card autosave against the agenda revision', () => {
  it.effect('a settled draft follows a fresh read of the same record without saving', () =>
    Effect.gen(function* settled() {
      const server = serverOf(3, at);
      const panel = yield* openPanel(server, { asset: opened, snapshot: snapshotOf(3, at) });
      // Someone else edits the note; the page re-reads the record.
      const edited = assetOf({ note: 'Vyměněno 2026', updatedAt: later });
      server.recordUpdatedAt = DateTime.makeUnsafe(later);
      server.revision = 4;
      yield* panel.render({ asset: edited, snapshot: snapshotOf(4, later) });
      expect(panel.draft().note).toBe('Vyměněno 2026');
      expect(panel.base().snapshot).toBe(DateTime.formatIso(edited.updatedAt));
      expect(server.applied).toEqual([]);
      expect(panel.status()).toBe('idle');
    }),
  );

  it.effect('a draft the user is editing keeps its base, so the change conflicts instead of being overwritten', () =>
    Effect.gen(function* dirty() {
      const server = serverOf(3, at);
      const panel = yield* openPanel(server, { asset: opened, snapshot: snapshotOf(3, at) });
      panel.type({ ...stored, note: 'Moje poznámka' });
      // Someone else edits the record while the draft is dirty; the page re-reads it.
      const edited = assetOf({ note: 'Jejich poznámka', updatedAt: later });
      server.recordUpdatedAt = DateTime.makeUnsafe(later);
      server.revision = 4;
      yield* panel.render({ asset: edited, snapshot: snapshotOf(4, later) });
      expect(panel.draft().note).toBe('Moje poznámka');
      expect(panel.base().snapshot).toBe(openedAt);
      panel.flush();
      yield* Effect.yieldNow;
      // The save went out with the revision the draft was built on, not the newer one the refresh brought.
      expect(server.applied).toHaveLength(1);
      expect(server.applied[0]?.expectedRevision).toBe(3);
      const update = Option.getOrThrow(updateOf(server.applied[0]?.command));
      expect(update.assetId).toBe(assetId);
      expect(update.note).toBe('Moje poznámka');
      expect(panel.status()).toBe('conflict');
      // „Načíst aktuální verzi“ adopts the version someone else saved.
      yield* panel.reloadLatest();
      expect(panel.draft().note).toBe('Jejich poznámka');
      expect(panel.status()).toBe('idle');
    }),
  );

  it.effect('a fresh read of a different record replaces the draft and its base', () =>
    Effect.gen(function* otherRecord() {
      const server = serverOf(3, at);
      const panel = yield* openPanel(server, { asset: opened, snapshot: snapshotOf(3, at) });
      panel.type({ ...stored, note: 'Rozpracované' });
      const other = assetOf({ id: 'asset-2', name: 'Kotel', note: 'Nový kotel', updatedAt: later });
      yield* panel.render({ asset: other, snapshot: snapshotOf(4, later) });
      expect(panel.draft()).toMatchObject({ name: 'Kotel', note: 'Nový kotel' });
      expect(panel.base().assetId).toBe('asset-2');
      expect(panel.status()).toBe('idle');
    }),
  );

  it.effect('a change elsewhere in the agenda keeps a dirty draft saveable', () =>
    Effect.gen(function* elsewhere() {
      const server = serverOf(3, at);
      const panel = yield* openPanel(server, { asset: opened, snapshot: snapshotOf(3, at) });
      panel.type({ ...stored, responsible: 'Petr Svoboda' });
      // Another asset changed: the agenda revision moves, this record does not.
      server.revision = 4;
      yield* panel.render({ asset: assetOf({ updatedAt: at }), snapshot: snapshotOf(4, later) });
      panel.flush();
      yield* Effect.yieldNow;
      expect(server.applied[0]?.expectedRevision).toBe(3);
      expect(panel.status()).toBe('saved');
    }),
  );
});
