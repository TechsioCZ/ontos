// @rstest-environment happy-dom
// Mounted asset-card draft with real property records and governed Action clients, served in process.
// Deferred HTTP replies let refreshed reads arrive before the save settles.
import { useAssetCardDraft } from '../../src/routes/[lang]/provoz/majetek/asset-card-save.ts';
import type { AssetCardDraftSave, RunAssetCommand } from '../../src/routes/[lang]/provoz/majetek/asset-card-save.ts';
import { assetCardDraftOf } from '../../src/routes/[lang]/provoz/majetek/asset-card-draft.ts';
import type { AssetCardDraft } from '../../src/routes/[lang]/provoz/majetek/asset-card-draft.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { settle as settleUi, waitUntil as waitForData } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { RecordsApi, RecordsResponseSchema } from '@app/property-portfolio/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import {
  ApplyCommandActionApi,
  ApplyCommandActionConflictProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import type { ApplyCommandPayloadSchema, ApplyCommandResult } from '../../shared/actions/apply-command.ts';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { AssetSchema } from '../../shared/domain/assets.ts';
import type { Asset } from '../../shared/domain/assets.ts';
import { DateTime, Deferred, Effect, Layer, Option, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

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

type Reply = Deferred.Deferred<ApplyCommandResult, typeof ApplyCommandActionConflictProblemSchema.Type>;

interface AgendaServer {
  recordUpdatedAt: DateTime.Utc;
  readonly replies: Reply[];
  revision: number;
  readonly saves: (typeof ApplyCommandPayloadSchema.Encoded)[];
}

const servers: AgendaServer[] = [];

const serverOf = (revision: number, recordUpdatedAt: DateTime.Utc): AgendaServer => {
  const server: AgendaServer = { recordUpdatedAt, replies: [], revision, saves: [] };
  servers.push(server);
  return server;
};

const conflict = Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
  _tag: 'ApplyCommandActionConflictProblem',
  code: 'facility_operations_revision_conflict',
  detail: 'The asset has changed since this draft was read.',
  status: 409,
  title: 'Revision conflict',
  type: 'urn:problem:facility-operations:revision-conflict',
});

const OwnerActionApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const PropertyRecordsApi = RecordsApi.prefix('/property-portfolio-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'facility-operations': '/facility-operations-api',
    'property-portfolio': '/property-portfolio-api',
  }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          const server = Option.getOrThrow(Option.fromUndefinedOr(servers.at(-1)));
          server.saves.push(payload);
          const reply = Deferred.makeUnsafe<ApplyCommandResult, typeof ApplyCommandActionConflictProblemSchema.Type>();
          server.replies.push(reply);
          return Deferred.await(reply);
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    PropertyRecordsApi,
    HttpApiBuilder.group(PropertyRecordsApi, 'records', (group) =>
      group.handle('execute', () =>
        Effect.succeed(
          Schema.decodeUnknownSync(RecordsResponseSchema)({
            assets: [],
            properties: [],
            revision: 0,
            units: [],
          }),
        ),
      ),
    ),
  ),
);

/** The snapshot supplied by the page goes through the real governed command runner. */
const runnerOf =
  (snapshot: Snapshot): RunAssetCommand =>
  (command) =>
    runCommand(command, snapshot.revision, DateTime.formatIso(snapshot.updatedAt));

const replyOf = (server: AgendaServer, index: number) =>
  Option.getOrThrow(Option.fromUndefinedOr(server.replies[index]));

const answerSaved = (server: AgendaServer, index: number, acknowledged: Snapshot): void => {
  server.revision = acknowledged.revision;
  server.recordUpdatedAt = acknowledged.updatedAt;
  browserRuntime.runSync(Deferred.succeed(replyOf(server, index), { entityIds: [], revision: acknowledged.revision }));
};

const answerConflict = (server: AgendaServer, index: number): void => {
  browserRuntime.runSync(Deferred.fail(replyOf(server, index), conflict));
};

let latestDraft: AssetCardDraftSave | undefined;

const draftOf = (): AssetCardDraftSave => Option.getOrThrow(Option.fromUndefinedOr(latestDraft));

const Harness = ({ asset, run }: { readonly asset: Asset; readonly run: RunAssetCommand }) => {
  const value = useAssetCardDraft({ asset, run });
  useEffect(() => {
    latestDraft = value;
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
  await browserRuntime.runPromise(settleUi);
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

const waitUntil = (condition: () => boolean): Promise<void> => browserRuntime.runPromise(waitForData(condition));

const type = (value: AssetCardDraft) => {
  draftOf().setDraft(value);
};

afterEach(() => {
  for (const view of mountedViews) {
    view.unmount();
  }
  mountedViews.length = 0;
  for (const server of servers) {
    for (const reply of server.replies) {
      if (!Deferred.isDoneUnsafe(reply)) {
        browserRuntime.runSync(Deferred.fail(reply, conflict));
      }
    }
  }
  servers.length = 0;
});

describe('mounted asset card draft against refreshed reads', () => {
  it.live('a settled draft follows a refreshed same-record read and saves on its base', () =>
    Effect.gen(function* cleanRefresh() {
      yield* pinTestDocument;
      const server = serverOf(3, atInstant);
      const view = yield* Effect.promise(() => mount(opened, runnerOf({ revision: 3, updatedAt: atInstant })));
      const refreshed = assetOf({ note: 'Jejich poznámka', updatedAt: later });

      yield* Effect.promise(() =>
        act(async () => {
          view.render(refreshed, runnerOf({ revision: 4, updatedAt: laterInstant }));
          await settle();
        }),
      );

      expect(draftOf().draft.note).toBe('Jejich poznámka');
      expect(draftOf().status).toBe('idle');
      yield* networkIdle;
      expect(server.saves).toEqual([]);

      yield* Effect.promise(() =>
        act(async () => {
          type({ ...draftOf().draft, responsible: 'Petr Svoboda' });
        }),
      );
      yield* Effect.promise(() =>
        act(async () => {
          draftOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 1));

      expect(server.saves[0]?.expectedRevision).toBe(4);
      yield* Effect.promise(() =>
        act(async () => {
          answerSaved(server, 0, { revision: 5, updatedAt: newestInstant });
        }),
      );
      yield* Effect.promise(() => waitUntil(() => draftOf().status === 'saved'));
      yield* networkIdle;
      expect(server.saves).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('a dirty draft keeps its base, conflicts, and reload adopts the refreshed base', () =>
    Effect.gen(function* dirtyRefresh() {
      yield* pinTestDocument;
      const server = serverOf(3, atInstant);
      const view = yield* Effect.promise(() => mount(opened, runnerOf({ revision: 3, updatedAt: atInstant })));

      yield* Effect.promise(() =>
        act(async () => {
          type({ ...assetCardDraftOf(opened), note: 'Moje poznámka' });
        }),
      );
      expect(draftOf().status).toBe('dirty');

      const refreshed = assetOf({ note: 'Jejich poznámka', updatedAt: later });
      yield* Effect.promise(() =>
        act(async () => {
          view.render(refreshed, runnerOf({ revision: 4, updatedAt: laterInstant }));
          await settle();
        }),
      );

      expect(draftOf().draft.note).toBe('Moje poznámka');
      yield* Effect.promise(() =>
        act(async () => {
          draftOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 1));
      expect(server.saves[0]?.expectedRevision).toBe(3);

      yield* Effect.promise(() =>
        act(async () => {
          answerConflict(server, 0);
        }),
      );
      yield* Effect.promise(() => waitUntil(() => draftOf().status === 'conflict'));
      yield* networkIdle;
      expect(server.saves).toHaveLength(1);

      yield* Effect.promise(() =>
        act(async () => {
          draftOf().reloadLatest();
        }),
      );
      expect(draftOf().draft.note).toBe('Jejich poznámka');
      expect(draftOf().status).toBe('idle');

      yield* Effect.promise(() =>
        act(async () => {
          type({ ...draftOf().draft, note: 'Po konfliktu' });
        }),
      );
      yield* Effect.promise(() =>
        act(async () => {
          draftOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 2));

      expect(server.saves[1]?.expectedRevision).toBe(4);
      yield* Effect.promise(() =>
        act(async () => {
          answerSaved(server, 1, { revision: 5, updatedAt: newestInstant });
        }),
      );
      yield* Effect.promise(() => waitUntil(() => draftOf().status === 'saved'));
      yield* networkIdle;
      expect(server.saves).toHaveLength(2);
    }).pipe(Effect.provide(network)),
  );

  it.live('a refreshed read of a different record replaces the draft and its base', () =>
    Effect.gen(function* otherRecord() {
      yield* pinTestDocument;
      const server = serverOf(3, atInstant);
      const view = yield* Effect.promise(() => mount(opened, runnerOf({ revision: 3, updatedAt: atInstant })));

      yield* Effect.promise(() =>
        act(async () => {
          type({ ...assetCardDraftOf(opened), note: 'Rozpracované' });
        }),
      );

      const other = assetOf({ id: 'asset-2', name: 'Kotel', note: 'Nový kotel', updatedAt: later });
      yield* Effect.promise(() =>
        act(async () => {
          view.render(other, runnerOf({ revision: 4, updatedAt: laterInstant }));
          await settle();
        }),
      );

      expect(draftOf().draft).toMatchObject({ name: 'Kotel', note: 'Nový kotel' });
      yield* Effect.promise(() =>
        act(async () => {
          type({ ...draftOf().draft, note: 'Nový kotel 2' });
        }),
      );
      yield* Effect.promise(() =>
        act(async () => {
          draftOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 1));

      expect(server.saves[0]?.expectedRevision).toBe(4);
      yield* Effect.promise(() =>
        act(async () => {
          answerSaved(server, 0, { revision: 5, updatedAt: newestInstant });
        }),
      );
      yield* Effect.promise(() => waitUntil(() => draftOf().status === 'saved'));
      yield* networkIdle;
      expect(server.saves).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('a save whose acknowledged read lands while pending settles onto the new base', () =>
    Effect.gen(function* pendingAcknowledgement() {
      yield* pinTestDocument;
      const server = serverOf(3, atInstant);
      const view = yield* Effect.promise(() => mount(opened, runnerOf({ revision: 3, updatedAt: atInstant })));

      yield* Effect.promise(() =>
        act(async () => {
          type({ ...assetCardDraftOf(opened), note: 'Moje poznámka' });
        }),
      );
      yield* Effect.promise(() =>
        act(async () => {
          draftOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 1));
      expect(server.saves[0]?.expectedRevision).toBe(3);

      // The action applied and the page re-read the record before the save controller settled.
      const acknowledged = assetOf({ note: 'Moje poznámka', updatedAt: later });
      yield* Effect.promise(() =>
        act(async () => {
          server.revision = 4;
          server.recordUpdatedAt = laterInstant;
          view.render(acknowledged, runnerOf({ revision: 4, updatedAt: laterInstant }));
          await settle();
        }),
      );
      expect(draftOf().status).toBe('saving');
      expect(draftOf().draft.note).toBe('Moje poznámka');

      yield* Effect.promise(() =>
        act(async () => {
          answerSaved(server, 0, { revision: 4, updatedAt: laterInstant });
          await settle();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => draftOf().status === 'saved'));
      yield* networkIdle;
      expect(server.saves).toHaveLength(1);

      // A second edit after the save settled must use the acknowledged base, not the old read's runner.
      yield* Effect.promise(() =>
        act(async () => {
          type({ ...draftOf().draft, note: 'Druhá poznámka' });
        }),
      );
      yield* Effect.promise(() =>
        act(async () => {
          draftOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 2));

      expect(server.saves[1]?.expectedRevision).toBe(4);
      yield* Effect.promise(() =>
        act(async () => {
          answerSaved(server, 1, { revision: 5, updatedAt: newestInstant });
        }),
      );
      yield* Effect.promise(() => waitUntil(() => draftOf().status === 'saved'));
      yield* networkIdle;
      expect(server.saves).toHaveLength(2);
    }).pipe(Effect.provide(network)),
  );

  it.live('a refresh batched with a typed edit does not overwrite the edit', () =>
    Effect.gen(function* refreshRace() {
      yield* pinTestDocument;
      const server = serverOf(3, atInstant);
      const view = yield* Effect.promise(() => mount(opened, runnerOf({ revision: 3, updatedAt: atInstant })));
      const mine: AssetCardDraft = { ...assetCardDraftOf(opened), note: 'Moje nová poznámka' };
      const refreshed = assetOf({ note: 'Jejich poznámka', updatedAt: later });

      yield* Effect.promise(() =>
        act(async () => {
          type(mine);
          view.render(refreshed, runnerOf({ revision: 4, updatedAt: laterInstant }));
          await settle();
        }),
      );

      expect(draftOf().draft.note).toBe('Moje nová poznámka');

      yield* Effect.promise(() =>
        act(async () => {
          draftOf().save();
        }),
      );
      yield* Effect.promise(() => waitUntil(() => server.saves.length === 1));
      expect(server.saves[0]?.command).toMatchObject({ note: 'Moje nová poznámka' });

      yield* Effect.promise(() =>
        act(async () => {
          answerConflict(server, 0);
        }),
      );
      yield* Effect.promise(() => waitUntil(() => draftOf().status === 'conflict'));
      yield* networkIdle;
      expect(server.saves).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );
});
