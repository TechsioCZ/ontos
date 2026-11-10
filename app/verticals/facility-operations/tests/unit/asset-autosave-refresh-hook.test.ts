// @rstest-environment happy-dom
// Mounted asset-card autosave: the actual `useAssetCardAutosave` with the real `useDraftSave` controller. Only the
// property-tree read and the page's governed runner are replaced, so this proves the render-phase refresh ordering
// that the controller-level `asset-autosave-revision.test.ts` cannot: an acknowledged same-record asset that arrives
// while the save is still pending must move the draft and its base to that read once the save settles.
import { useAssetCardAutosave } from '../../src/routes/[lang]/provoz/majetek/asset-card-autosave.ts';
import type { AssetCardAutosave, RunAssetCommand } from '../../src/routes/[lang]/provoz/majetek/asset-card-autosave.ts';
import { assetCardDraftOf } from '../../src/routes/[lang]/provoz/majetek/asset-card-draft.ts';
import type { AssetCardDraft } from '../../src/routes/[lang]/provoz/majetek/asset-card-draft.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import type { CommandOutcome } from '../../src/ui/use-agenda.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import { AssetSchema } from '../../shared/domain/assets.ts';
import type { Asset } from '../../shared/domain/assets.ts';
import { DateTime, Deferred, Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

const { propertyRead } = rstest.hoisted(() => ({ propertyRead: rstest.fn() }));

rstest.mock('@app/property-portfolio/clients/records', () => ({ executeRecords: propertyRead }));

const assetId = 'asset-1';
const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const at = '2026-10-20T08:00:00Z';
const later = '2026-10-21T09:30:00Z';
const newest = '2026-10-22T10:15:00Z';
const atInstant = DateTime.makeUnsafe(at);
const laterInstant = DateTime.makeUnsafe(later);
const newestInstant = DateTime.makeUnsafe(newest);
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

interface Snapshot {
  readonly revision: number;
  readonly updatedAt: DateTime.Utc;
}

interface SentSave {
  readonly command: OpsCommand;
  readonly expectedRevision: number;
  readonly snapshotUpdatedAt: DateTime.Utc;
}

/** The assets agenda behind the fake page runner: its revision and the record's own update instant. */
interface AgendaServer {
  recordUpdatedAt: DateTime.Utc;
  readonly replies: Deferred.Deferred<CommandOutcome>[];
  revision: number;
  readonly saves: SentSave[];
}

const servers: AgendaServer[] = [];

const serverOf = (revision: number, recordUpdatedAt: DateTime.Utc): AgendaServer => {
  const server: AgendaServer = { recordUpdatedAt, replies: [], revision, saves: [] };
  servers.push(server);
  return server;
};

/** The page runner of one read: it sends that read's revision and instant, like `useAgendaRecords` does. */
const runnerOf =
  (server: AgendaServer, snapshot: Snapshot): RunAssetCommand =>
  (command) =>
    Effect.suspend(() => {
      server.saves.push({
        command,
        expectedRevision: snapshot.revision,
        snapshotUpdatedAt: snapshot.updatedAt,
      });
      const reply = Deferred.makeUnsafe<CommandOutcome>();
      server.replies.push(reply);
      return Deferred.await(reply);
    });

const replyOf = (server: AgendaServer, index: number) =>
  Option.getOrThrow(Option.fromUndefinedOr(server.replies[index]));

const answerSaved = (server: AgendaServer, index: number, acknowledged: Snapshot): void => {
  server.revision = acknowledged.revision;
  server.recordUpdatedAt = acknowledged.updatedAt;
  browserRuntime.runSync(
    Deferred.succeed(replyOf(server, index), {
      ok: true,
      result: { entityIds: [], revision: acknowledged.revision },
    }),
  );
};

const answerConflict = (server: AgendaServer, index: number): void => {
  browserRuntime.runSync(Deferred.succeed(replyOf(server, index), { ok: false, reason: 'conflict' }));
};

let latestAutosave: AssetCardAutosave | undefined;

const autosaveOf = (): AssetCardAutosave => Option.getOrThrow(Option.fromUndefinedOr(latestAutosave));

const Harness = ({ asset, run }: { readonly asset: Asset; readonly run: RunAssetCommand }) => {
  const value = useAssetCardAutosave({ asset, run });
  useEffect(() => {
    latestAutosave = value;
  }, [value]);
  return null;
};

interface Mounted {
  readonly render: (asset: Asset, run: RunAssetCommand) => void;
  readonly rerender: (asset: Asset, run: RunAssetCommand) => void;
  readonly unmount: () => void;
}

const mountedViews: Mounted[] = [];

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const mount = async (asset: Asset, run: RunAssetCommand): Promise<Mounted> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let live = true;
  const render = (nextAsset: Asset, nextRun: RunAssetCommand) => {
    root.render(createElement(Harness, { asset: nextAsset, run: nextRun }));
  };
  const view: Mounted = {
    render,
    rerender: (nextAsset, nextRun) => {
      act(() => {
        render(nextAsset, nextRun);
      });
    },
    unmount: () => {
      if (!live) {
        return;
      }
      live = false;
      act(() => {
        root.unmount();
        container.remove();
      });
    },
  };
  mountedViews.push(view);
  act(() => {
    render(asset, run);
  });
  await act(settle);
  return view;
};

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition()) {
    return;
  }
  if (attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

const type = (value: AssetCardDraft) => {
  autosaveOf().setDraft(value);
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  propertyRead.mockReset();
  propertyRead.mockReturnValue(Effect.succeed({ properties: [], units: [] }));
});

afterEach(() => {
  for (const view of mountedViews) {
    view.unmount();
  }
  mountedViews.length = 0;
  for (const server of servers) {
    for (const reply of server.replies) {
      if (!Deferred.isDoneUnsafe(reply)) {
        browserRuntime.runSync(Deferred.succeed(reply, { ok: false, reason: 'conflict' }));
      }
    }
  }
  servers.length = 0;
  rstest.unstubAllGlobals();
});

describe('mounted asset card autosave against refreshed reads', () => {
  it.effect('a settled draft follows a refreshed same-record read and saves on its base', () =>
    Effect.gen(function* cleanRefresh() {
      const server = serverOf(3, atInstant);
      const view = yield* Effect.promise(() => mount(opened, runnerOf(server, { revision: 3, updatedAt: atInstant })));
      const refreshed = assetOf({ note: 'Jejich poznámka', updatedAt: later });

      yield* Effect.promise(() =>
        act(async () => {
          view.render(refreshed, runnerOf(server, { revision: 4, updatedAt: laterInstant }));
          await settle();
        }),
      );

      expect(autosaveOf().draft.note).toBe('Jejich poznámka');
      expect(autosaveOf().status).toBe('idle');
      expect(server.saves).toEqual([]);

      yield* Effect.promise(() =>
        act(async () => {
          type({ ...autosaveOf().draft, responsible: 'Petr Svoboda' });
        }),
      );
      yield* Effect.promise(() =>
        act(async () => {
          autosaveOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 1));

      expect(server.saves[0]?.expectedRevision).toBe(4);
      yield* Effect.promise(() =>
        act(async () => {
          answerSaved(server, 0, { revision: 5, updatedAt: newestInstant });
        }),
      );
      yield* Effect.promise(() => waitUntil(() => autosaveOf().status === 'saved'));
    }),
  );

  it.effect('a dirty draft keeps its base, conflicts, and reload adopts the refreshed base', () =>
    Effect.gen(function* dirtyRefresh() {
      const server = serverOf(3, atInstant);
      const view = yield* Effect.promise(() => mount(opened, runnerOf(server, { revision: 3, updatedAt: atInstant })));

      yield* Effect.promise(() =>
        act(async () => {
          type({ ...assetCardDraftOf(opened), note: 'Moje poznámka' });
        }),
      );
      expect(autosaveOf().status).toBe('dirty');

      const refreshed = assetOf({ note: 'Jejich poznámka', updatedAt: later });
      yield* Effect.promise(() =>
        act(async () => {
          view.render(refreshed, runnerOf(server, { revision: 4, updatedAt: laterInstant }));
          await settle();
        }),
      );

      expect(autosaveOf().draft.note).toBe('Moje poznámka');
      yield* Effect.promise(() =>
        act(async () => {
          autosaveOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 1));
      expect(server.saves[0]?.expectedRevision).toBe(3);

      yield* Effect.promise(() =>
        act(async () => {
          answerConflict(server, 0);
        }),
      );
      yield* Effect.promise(() => waitUntil(() => autosaveOf().status === 'conflict'));

      yield* Effect.promise(() =>
        act(async () => {
          autosaveOf().reloadLatest();
        }),
      );
      expect(autosaveOf().draft.note).toBe('Jejich poznámka');
      expect(autosaveOf().status).toBe('idle');

      yield* Effect.promise(() =>
        act(async () => {
          type({ ...autosaveOf().draft, note: 'Po konfliktu' });
        }),
      );
      yield* Effect.promise(() =>
        act(async () => {
          autosaveOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 2));

      expect(server.saves[1]?.expectedRevision).toBe(4);
      yield* Effect.promise(() =>
        act(async () => {
          answerSaved(server, 1, { revision: 5, updatedAt: newestInstant });
        }),
      );
      yield* Effect.promise(() => waitUntil(() => autosaveOf().status === 'saved'));
    }),
  );

  it.effect('a refreshed read of a different record replaces the draft and its base', () =>
    Effect.gen(function* otherRecord() {
      const server = serverOf(3, atInstant);
      const view = yield* Effect.promise(() => mount(opened, runnerOf(server, { revision: 3, updatedAt: atInstant })));

      yield* Effect.promise(() =>
        act(async () => {
          type({ ...assetCardDraftOf(opened), note: 'Rozpracované' });
        }),
      );

      const other = assetOf({ id: 'asset-2', name: 'Kotel', note: 'Nový kotel', updatedAt: later });
      yield* Effect.promise(() =>
        act(async () => {
          view.render(other, runnerOf(server, { revision: 4, updatedAt: laterInstant }));
          await settle();
        }),
      );

      expect(autosaveOf().draft).toMatchObject({ name: 'Kotel', note: 'Nový kotel' });
      yield* Effect.promise(() =>
        act(async () => {
          type({ ...autosaveOf().draft, note: 'Nový kotel 2' });
        }),
      );
      yield* Effect.promise(() =>
        act(async () => {
          autosaveOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 1));

      expect(server.saves[0]?.expectedRevision).toBe(4);
      yield* Effect.promise(() =>
        act(async () => {
          answerSaved(server, 0, { revision: 5, updatedAt: newestInstant });
        }),
      );
      yield* Effect.promise(() => waitUntil(() => autosaveOf().status === 'saved'));
    }),
  );

  it.effect('a save whose acknowledged read lands while pending settles onto the new base', () =>
    Effect.gen(function* pendingAcknowledgement() {
      const server = serverOf(3, atInstant);
      const view = yield* Effect.promise(() => mount(opened, runnerOf(server, { revision: 3, updatedAt: atInstant })));

      yield* Effect.promise(() =>
        act(async () => {
          type({ ...assetCardDraftOf(opened), note: 'Moje poznámka' });
        }),
      );
      yield* Effect.promise(() =>
        act(async () => {
          autosaveOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 1));
      expect(server.saves[0]?.expectedRevision).toBe(3);

      // The action applied and the page re-read the record before the autosave controller settled.
      const acknowledged = assetOf({ note: 'Moje poznámka', updatedAt: later });
      yield* Effect.promise(() =>
        act(async () => {
          server.revision = 4;
          server.recordUpdatedAt = laterInstant;
          view.render(acknowledged, runnerOf(server, { revision: 4, updatedAt: laterInstant }));
          await settle();
        }),
      );
      expect(autosaveOf().status).toBe('saving');
      expect(autosaveOf().draft.note).toBe('Moje poznámka');

      yield* Effect.promise(() =>
        act(async () => {
          answerSaved(server, 0, { revision: 4, updatedAt: laterInstant });
          await settle();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => autosaveOf().status === 'saved'));

      // A second edit after the save settled must use the acknowledged base, not the old read's runner.
      yield* Effect.promise(() =>
        act(async () => {
          type({ ...autosaveOf().draft, note: 'Druhá poznámka' });
        }),
      );
      yield* Effect.promise(() =>
        act(async () => {
          autosaveOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 2));

      expect(server.saves[1]?.expectedRevision).toBe(4);
      yield* Effect.promise(() =>
        act(async () => {
          answerSaved(server, 1, { revision: 5, updatedAt: newestInstant });
        }),
      );
      yield* Effect.promise(() => waitUntil(() => autosaveOf().status === 'saved'));
    }),
  );

  it.effect('a refresh batched with a typed edit does not overwrite the edit', () =>
    Effect.gen(function* refreshRace() {
      const server = serverOf(3, atInstant);
      const view = yield* Effect.promise(() => mount(opened, runnerOf(server, { revision: 3, updatedAt: atInstant })));
      const mine: AssetCardDraft = { ...assetCardDraftOf(opened), note: 'Moje nová poznámka' };
      const refreshed = assetOf({ note: 'Jejich poznámka', updatedAt: later });

      yield* Effect.promise(() =>
        act(async () => {
          type(mine);
          view.render(refreshed, runnerOf(server, { revision: 4, updatedAt: laterInstant }));
          await settle();
        }),
      );

      expect(autosaveOf().draft.note).toBe('Moje nová poznámka');

      yield* Effect.promise(() =>
        act(async () => {
          autosaveOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 1));
      expect(server.saves[0]?.command).toMatchObject({ note: 'Moje nová poznámka' });

      yield* Effect.promise(() =>
        act(async () => {
          answerConflict(server, 0);
        }),
      );
      yield* Effect.promise(() => waitUntil(() => autosaveOf().status === 'conflict'));
    }),
  );
});
