// @rstest-environment node
/**
 * Which owner Action a stored or module-supplied command runs as, and with which body. The module's published
 * command unions (`commandActions` of its MCP contribution) decide; the Shell names no module, Action or tag.
 */
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import type { AgentCommand } from '@app/shared-contracts/agent-proposals';
import { Effect, Layer, Schema } from 'effect';
import { beforeEach, expect, it, rs } from 'effect-rstest';

import {
  commandRevisionFrom,
  composedModulesOf,
  revisionQueryOf,
} from '../../../api/agent-platform/composed-modules.ts' with { rstest: 'importActual' };
import { applyModuleCommand, commandTargetOf } from '../../../api/agent-platform/module-call.ts';
import type { ModuleCommandAction } from '../../../api/agent-platform/module-call.ts';
import { AgentReadRequestIdentity } from '../../../api/auth/agent-request-identity.ts';
import { GatewayIssuer } from '../../../api/auth/gateway-issuer.ts';
import { buildMcpModules } from '../../../api/mcp/catalog.ts';
import { ShellInstalledModuleCatalog } from '../../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';
import { FIXTURE_APP_ID, FIXTURE_MODULE_ID, fixtureComposition, fixtureModule } from '../mcp/fixture-vertical.ts';

/** A module whose catch-all `apply-command` was split: creation stays, catalog changes and reviews moved. */
const commandActions = {
  AiDecideChanges: ['review-changes'],
  AiRevertBatch: ['review-changes'],
  ChangePrice: ['manage-catalog'],
  CreateProduct: ['apply-command'],
  UpdateProduct: ['manage-catalog'],
};
const actionsPath = `/${FIXTURE_APP_ID}/actions`;
const JsonText = Schema.fromJsonString(Schema.Json);

const state = rs.hoisted(() => {
  const sent: { readonly body: Schema.Json; readonly path: string }[] = [];
  return { published: true, sent };
});

rs.mock('../../../src/module-api/transport.ts', () => ({
  dispatchModuleApiRequest: (request: Request) =>
    Effect.promise(() => request.text()).pipe(
      Effect.flatMap(Schema.decodeEffect(JsonText)),
      Effect.orDie,
      Effect.map((body) => {
        const path = new URL(request.url).pathname;
        state.sent.push({ body, path });
        return Response.json(path.endsWith('/reads/records') ? { revision: 7 } : { applied: true });
      }),
    ),
}));
rs.mock('../../../api/agent-platform/composed-modules.ts', () => ({
  commandRevisionFrom,
  composedModulesOf,
  // The module's contract publishes its command unions only when `state.published`.
  get loadComposedModules() {
    const source = composedModulesOf(buildMcpModules(fixtureComposition)).byAppId(FIXTURE_APP_ID);
    const mcp = state.published ? { ...source, approvals: true, commandActions } : { ...source, approvals: true };
    const contract = { manifest: { publicSurface: { mcp } } };
    return Effect.succeed(
      composedModulesOf(
        buildMcpModules({
          modules: [fixtureModule(FIXTURE_MODULE_ID, FIXTURE_APP_ID, JSON.stringify(contract), 'http://127.0.0.1:9')],
          revision: fixtureComposition.revision,
        }),
      ),
    );
  },
  revisionQueryOf,
}));

beforeEach(() => {
  state.sent.length = 0;
  state.published = true;
});

const principal: TrustedPrincipalContext = {
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'session:module-call',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};

const run = (command: AgentCommand, action: ModuleCommandAction) =>
  Effect.gen(function* runCommand() {
    const snapshot = yield* makeCompositionSnapshot([]);
    return yield* applyModuleCommand(principal, FIXTURE_APP_ID, command, { action, idempotencyKey: 'key-1' }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
          Layer.succeed(AgentReadRequestIdentity, { correlationId: 'module-call' }),
          Layer.mock(GatewayIssuer, {
            issue: () =>
              Effect.succeed({
                apiBaseUrl: '/fixture-api',
                compositionRevision: snapshot.composition.revision,
                expiresAt: 0,
                token: 't',
              }),
          }),
          Layer.mock(ShellInstalledModuleCatalog, {}),
        ),
      ),
    );
  });

it.effect('approves a split command on its own Action with the envelope and the revision read just now', () =>
  Effect.gen(function* splitApproval() {
    const command = { _tag: 'ChangePrice', id: 'p-1', priceMinor: 12_300 };
    const outcome = yield* run(command, { exact: 'manage-catalog' });
    expect(outcome).toEqual({ body: { applied: true }, ok: true });
    expect(state.sent).toEqual([
      { body: {}, path: '/fixture-api/reads/records' },
      { body: { command, expectedRevision: 7 }, path: `/fixture-api${actionsPath}/manage-catalog` },
    ]);
  }),
);

it.effect('keeps an unsplit apply-command owner on apply-command with the envelope and revision', () =>
  Effect.gen(function* unsplitApproval() {
    const command = { _tag: 'CreateProduct', name: 'Mug' };
    expect((yield* run(command, { exact: 'apply-command' })).ok).toBe(true);
    expect(state.sent.at(-1)).toEqual({
      body: { command, expectedRevision: 7 },
      path: `/fixture-api${actionsPath}/apply-command`,
    });
  }),
);

it.effect('never runs an approved command as another Action than the one it was authorized for', () =>
  Effect.gen(function* noSubstitution() {
    const outcome = yield* run({ _tag: 'ChangePrice', id: 'p-1', priceMinor: 1 }, { exact: 'apply-command' });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
    // Not even a revision read: nothing is posted to any Action.
    expect(state.sent).toEqual([]);
  }),
);

it.effect('posts a named Action payload as stored, without envelope or revision read', () =>
  Effect.gen(function* namedApproval() {
    const command = { name: 'Acme', partyId: 'party-1' };
    expect((yield* run(command, { exact: 'update-party' })).ok).toBe(true);
    expect(state.sent).toEqual([{ body: command, path: `/fixture-api${actionsPath}/update-party` }]);
  }),
);

it.effect('runs an AI change decision of the module engine on the Action that owns it', () =>
  Effect.gen(function* legacyDecision() {
    const command = { _tag: 'AiDecideChanges', changeIds: ['c-1'], decision: 'approve' };
    expect((yield* run(command, {})).ok).toBe(true);
    expect(state.sent.at(-1)).toEqual({
      body: { command, expectedRevision: 7 },
      path: `/fixture-api${actionsPath}/review-changes`,
    });
  }),
);

it.effect('runs a module undo command on its owning Action, not the approved one', () =>
  Effect.gen(function* undo() {
    const command = { _tag: 'UpdateProduct', id: 'p-1', patch: { active: false } };
    expect((yield* run(command, { preferred: 'apply-command' })).ok).toBe(true);
    expect(state.sent.at(-1)?.path).toBe(`/fixture-api${actionsPath}/manage-catalog`);
  }),
);

it.effect('refuses a tagged command when the module publishes no command union', () =>
  Effect.gen(function* noUnions() {
    state.published = false;
    const outcome = yield* run({ _tag: 'CreateProduct', name: 'Mug' }, { exact: 'apply-command' });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
    expect(state.sent).toEqual([]);
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
});
