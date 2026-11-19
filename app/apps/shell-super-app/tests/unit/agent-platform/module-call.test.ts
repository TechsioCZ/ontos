// @rstest-environment node
/**
 * Which owner Action a stored or module-supplied command runs as, and with which body. The module's published
 * command unions (`commandActions` of its MCP contribution) decide; the Shell names no module, Action or tag. The
 * command reaches a real owner release through the Shell's native module transport.
 */
import type { TrustedPrincipalContext } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime/modules/active-application-composition';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import type { AgentCommand } from '@app/shared-contracts/agent-proposals';
import { Effect, Layer, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';

import { applyModuleCommand, commandTargetOf } from '../../../api/agent-platform/module-call.ts';
import type { ModuleCommandAction } from '../../../api/agent-platform/module-call.ts';
import { AgentReadRequestIdentity } from '../../../api/auth/agent-request-identity.ts';
import { GatewayIssuer } from '../../../api/auth/gateway-issuer.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot, sealComposition } from '../../fixtures/application-composition.ts';
import { startNativeHttpServer } from '../../support/native-http-server.ts';
import { FIXTURE_APP_ID, FIXTURE_CONTRACT_DOCUMENT, FIXTURE_MODULE_ID } from '../mcp/fixture-vertical.ts';

/** A module whose catch-all `apply-command` was split: creation stays, catalog changes and reviews moved. */
const commandActions = {
  AiDecideChanges: ['review-changes'],
  AiRevertBatch: ['review-changes'],
  ChangePrice: ['manage-catalog'],
  CreateProduct: ['apply-command'],
  UpdateProduct: ['manage-catalog'],
};
const BUILD = 'build';
const API_BASE = `/module-api/${FIXTURE_APP_ID}/${BUILD}/${FIXTURE_APP_ID}-api`;
/** The owner release's own API root, where the Shell's relay delivers the module path. */
const OWNER_BASE = `/${FIXTURE_APP_ID}-api`;
const actionsPath = `${OWNER_BASE}/${FIXTURE_APP_ID}/actions`;
const JsonText = Schema.fromJsonString(Schema.Json);
const FixtureContract = Schema.fromJsonString(
  Schema.Struct({ manifest: Schema.Struct({ publicSurface: Schema.Struct({ mcp: Schema.JsonObject }) }) }),
);
/** The fixture module's MCP contribution, as its release publishes it. */
const { mcp: contribution } =
  Schema.decodeUnknownSync(FixtureContract)(FIXTURE_CONTRACT_DOCUMENT).manifest.publicSurface;

/** What the owner release received: the path and the JSON body of each request. */
const sent: { readonly body: Schema.Json; readonly path: string }[] = [];

beforeEach(() => {
  sent.length = 0;
});

/**
 * The fixture module installed at a real owner release. With `published`, its contract publishes the command
 * unions; without, it publishes none. The owner answers its records read with revision 7 and every Action with
 * `{ applied: true }`.
 */
const installedModule = (published: boolean) =>
  Effect.gen(function* installFixtureModule() {
    const server = yield* startNativeHttpServer(async (request) => {
      const path = new URL(request.url).pathname;
      const body = Schema.decodeUnknownSync(JsonText)(await request.text());
      sent.push({ body, path });
      return Response.json(path.endsWith('/reads/records') ? { revision: 7 } : { applied: true });
    });
    const fixture = makeModuleContractFixture({
      appId: FIXTURE_APP_ID,
      buildMarker: BUILD,
      moduleId: FIXTURE_MODULE_ID,
    });
    const mcp = published ? { ...contribution, commandActions } : contribution;
    const original = yield* makeCompositionSnapshot([
      { ...fixture, manifest: { ...fixture.manifest, publicSurface: { ...fixture.manifest.publicSurface, mcp } } },
    ]);
    const snapshot = {
      ...original,
      composition: sealComposition({
        ...original.composition,
        modules: original.composition.modules.map((module) => ({
          ...module,
          backend: { baseUrl: `${server.origin}/`, transport: 'node-http' as const },
        })),
      }),
    };
    return snapshot;
  });

const principal: TrustedPrincipalContext = {
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'session:module-call',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};

const run = (command: AgentCommand, action: ModuleCommandAction, published = true) =>
  Effect.gen(function* runCommand() {
    const snapshot = yield* installedModule(published);
    const load = Effect.succeed(snapshot);
    return yield* applyModuleCommand(principal, FIXTURE_APP_ID, command, { action, idempotencyKey: 'key-1' }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ActiveApplicationCompositionService, makeActiveApplicationCompositionService(load)),
          Layer.succeed(AgentReadRequestIdentity, { correlationId: 'module-call' }),
          Layer.mock(GatewayIssuer, {
            issue: () =>
              Effect.succeed({
                apiBaseUrl: API_BASE,
                compositionRevision: snapshot.composition.revision,
                expiresAt: 0,
                token: 't',
              }),
          }),
          Layer.mock(ShellInstalledModuleCatalog, { load: makeInstalledModuleCatalogLoader(load) }),
        ),
      ),
    );
  }).pipe(Effect.scoped);

it.live('approves a split command on its own Action with the envelope and the revision read just now', () =>
  Effect.gen(function* splitApproval() {
    const command = { _tag: 'ChangePrice', id: 'p-1', priceMinor: 12_300 };
    const outcome = yield* run(command, { exact: 'manage-catalog' });
    expect(outcome).toEqual({ body: { applied: true }, ok: true });
    expect(sent).toEqual([
      { body: {}, path: `${OWNER_BASE}/reads/records` },
      { body: { command, expectedRevision: 7 }, path: `${actionsPath}/manage-catalog` },
    ]);
  }),
);

it.live('keeps an unsplit apply-command owner on apply-command with the envelope and revision', () =>
  Effect.gen(function* unsplitApproval() {
    const command = { _tag: 'CreateProduct', name: 'Mug' };
    expect((yield* run(command, { exact: 'apply-command' })).ok).toBe(true);
    expect(sent.at(-1)).toEqual({
      body: { command, expectedRevision: 7 },
      path: `${actionsPath}/apply-command`,
    });
  }),
);

it.live('never runs an approved command as another Action than the one it was authorized for', () =>
  Effect.gen(function* noSubstitution() {
    const outcome = yield* run({ _tag: 'ChangePrice', id: 'p-1', priceMinor: 1 }, { exact: 'apply-command' });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
    // Not even a revision read: nothing is posted to any Action.
    expect(sent).toEqual([]);
  }),
);

it.live('posts a named Action payload as stored, without envelope or revision read', () =>
  Effect.gen(function* namedApproval() {
    const command = { name: 'Acme', partyId: 'party-1' };
    expect((yield* run(command, { exact: 'update-party' })).ok).toBe(true);
    expect(sent).toEqual([{ body: command, path: `${actionsPath}/update-party` }]);
  }),
);

it.live('runs an AI change decision of the module engine on the Action that owns it', () =>
  Effect.gen(function* legacyDecision() {
    const command = { _tag: 'AiDecideChanges', changeIds: ['c-1'], decision: 'approve' };
    expect((yield* run(command, {})).ok).toBe(true);
    expect(sent.at(-1)).toEqual({
      body: { command, expectedRevision: 7 },
      path: `${actionsPath}/review-changes`,
    });
  }),
);

it.live('runs a module undo command on its owning Action, not the approved one', () =>
  Effect.gen(function* undo() {
    const command = { _tag: 'UpdateProduct', id: 'p-1', patch: { active: false } };
    expect((yield* run(command, { preferred: 'apply-command' })).ok).toBe(true);
    expect(sent.at(-1)?.path).toBe(`${actionsPath}/manage-catalog`);
  }),
);

it.live('refuses every command, tagged or named, when the module contract publishes no command map', () =>
  Effect.gen(function* staleContract() {
    for (const [command, exact] of [
      [{ _tag: 'CreateProduct', name: 'Mug' }, 'apply-command'],
      [{ name: 'Acme', partyId: 'party-1' }, 'update-party'],
    ] as const) {
      expect(yield* run(command, { exact }, false)).toMatchObject({ ok: false, status: 400 });
    }
    expect(sent).toEqual([]);
  }),
);

it.live('never posts a self-wrapped command envelope as a named Action payload', () =>
  Effect.gen(function* selfWrapped() {
    const decision = { _tag: 'AiDecideChanges', changeIds: ['c-1'], decision: 'approve' };
    for (const [command, exact] of [
      // The human-only decision, wrapped by the proposer, on its owning Action or on a named one.
      [{ command: decision, expectedRevision: 3 }, 'review-changes'],
      [{ command: decision }, 'update-party'],
      // An ordinary command is valid only tagged, on the Action that owns it.
      [{ command: { _tag: 'CreateProduct', name: 'Mug' }, expectedRevision: 1 }, 'apply-command'],
    ] as const) {
      expect(yield* run(command, { exact })).toMatchObject({ ok: false, status: 400 });
      expect(yield* run(command, { preferred: exact })).toMatchObject({ ok: false, status: 400 });
    }
    expect(sent).toEqual([]);
  }),
);

it('selects the owning Action from the published command unions only', () => {
  expect(commandTargetOf(commandActions, { _tag: 'ChangePrice' }, { exact: 'manage-catalog' })).toEqual({
    envelope: true,
    slug: 'manage-catalog',
  });
  expect(commandTargetOf(commandActions, { _tag: 'ChangePrice' }, { exact: 'apply-command' })).toBeUndefined();
  expect(commandTargetOf(commandActions, { name: 'x' }, { exact: 'manage-catalog' })).toBeUndefined();
  expect(commandTargetOf(commandActions, { name: 'x' }, { exact: 'update-party' })).toEqual({
    envelope: false,
    slug: 'update-party',
  });
  expect(commandTargetOf(commandActions, { name: 'x' }, { preferred: 'update-party' })).toEqual({
    envelope: false,
    slug: 'update-party',
  });
  expect(commandTargetOf(commandActions, { name: 'x' }, {})).toBeUndefined();
  expect(commandTargetOf(commandActions, { _tag: 'Unknown' }, {})).toBeUndefined();
  expect(commandTargetOf(undefined, { name: 'x' }, { exact: 'update-party' })).toBeUndefined();
  expect(
    commandTargetOf(
      commandActions,
      { command: { _tag: 'ChangePrice' }, expectedRevision: 1 },
      { exact: 'update-party' },
    ),
  ).toBeUndefined();
});
