// @rstest-environment happy-dom
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { AssetSchema } from '../../shared/domain/assets.ts';
import {
  assetCardBaseOf,
  assetCardRefreshOf,
  assetCardSaveOf,
} from '../../src/routes/[lang]/provoz/majetek/asset-card-save.ts';
import { assetCardDraftOf, assetCardUpdateCommandOf } from '../../src/routes/[lang]/provoz/majetek/asset-card-draft.ts';
import { assetPlacementOf } from '../../src/routes/[lang]/provoz/majetek/property-tree.ts';
import { runCommand } from '../../src/ui/use-agenda.ts';

const at = '2026-10-20T08:00:00Z';
const asset = Schema.decodeUnknownSync(AssetSchema)({
  category: 'Vytápění',
  createdAt: at,
  createdBy: { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' },
  id: 'asset-unrelated',
  inventoryNumber: 'MJ-17',
  kind: 'equipment',
  name: 'Kotel',
  updatedAt: at,
  updatedBy: { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' },
});
const requests: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
const Owner = ApplyCommandActionApi.prefix('/facility-operations-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'facility-operations': '/facility-operations-api' }).application,
  serveApi(
    Owner,
    HttpApiBuilder.group(Owner, 'applyCommandAction', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          requests.push(payload);
          return { entityIds: [], revision: 5 };
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
);

it.live('saves a dirty asset with its original revision when only another agenda record changed', () =>
  Effect.gen(function* unrelatedChange() {
    yield* pinTestDocument;
    const draft = { ...assetCardDraftOf(asset), responsible: 'Petr Svoboda' };
    const base = assetCardBaseOf((command) => runCommand(command, 3, at), asset);
    const refresh = assetCardRefreshOf({
      asset: { ...asset },
      base,
      draft,
      pending: true,
      run: (command) => runCommand(command, 4, '2026-10-21T09:30:00Z'),
    });
    expect(refresh.adopt).toBeNull();
    const save = assetCardSaveOf({
      base: () => refresh.base,
      commandOf: (value) =>
        assetCardUpdateCommandOf(value, asset, assetPlacementOf({ status: 'loading' }, value, asset)),
    });
    expect(yield* save.save(draft)).toBe('saved');
    expect(requests).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({ _tag: 'AssetUpdate', assetId: asset.id, responsible: 'Petr Svoboda' }),
        expectedRevision: 3,
      }),
    ]);
    expect(refresh.base.snapshot).toBe(DateTime.formatIso(asset.updatedAt));
  }).pipe(Effect.provide(network)),
);
