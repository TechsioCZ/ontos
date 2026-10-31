// @rstest-environment node
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { Crypto, Effect, Layer, PlatformError } from 'effect';
import { beforeEach, expect, it, rs } from 'effect-rstest';

import { AgentModuleCallError } from '../../../api/agent-platform/module-call.ts' with { rstest: 'importActual' };
import type { applyModuleCommand } from '../../../api/agent-platform/module-call.ts';
import { decideLegacy, revertLegacy } from '../../../api/agent-platform/legacy-queue.ts';
import { AgentReadRequestIdentity } from '../../../api/auth/agent-request-identity.ts';
import { GatewayIssuer } from '../../../api/auth/gateway-issuer.ts';
import { ShellInstalledModuleCatalog } from '../../../api/modules/installed-module-catalog.ts';

const calls = rs.hoisted(() => {
  const commands: Parameters<typeof applyModuleCommand>[] = [];
  return { commands };
});
rs.mock('../../../api/agent-platform/module-call.ts', () => ({
  get AgentModuleCallError() {
    return AgentModuleCallError;
  },
  applyModuleCommand: (...args: Parameters<typeof applyModuleCommand>) =>
    Effect.sync(() => {
      calls.commands.push(args);
      return { body: null, ok: true };
    }),
}));
beforeEach(() => {
  calls.commands.length = 0;
});
const principal: TrustedPrincipalContext = {
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'session:legacy-queue',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const cryptoFailure = PlatformError.systemError({
  _tag: 'Unknown',
  method: 'randomUUIDv4',
  module: 'Crypto',
});
const nativeCrypto = Crypto.make({
  digest: (_algorithm, data) => Effect.succeed(data),
  randomBytes: (size) => new Uint8Array(size).fill(5),
});
const unusedCollaborators = Layer.mergeAll(
  Layer.mock(ActiveApplicationCompositionService, {}),
  Layer.succeed(AgentReadRequestIdentity, { correlationId: 'legacy-command' }),
  Layer.mock(GatewayIssuer, {}),
  Layer.mock(ShellInstalledModuleCatalog, {}),
);

it.effect('generates native command keys lazily and preserves decision and revert payloads', () =>
  Effect.gen(function* nativeKeys() {
    let uuidCalls = 0;
    const crypto = Crypto.make({
      digest: (_algorithm, data) => Effect.succeed(data),
      randomBytes: (size) => {
        uuidCalls += 1;
        return new Uint8Array(size).fill(uuidCalls);
      },
    });
    const decide = decideLegacy(principal, 'crm', ['change-a'], 'approve', '  Reviewed  ');
    const revert = revertLegacy(principal, 'crm', 'batch-a', '  Restore  ');
    expect(uuidCalls).toBe(0);
    yield* decide.pipe(Effect.provideService(Crypto.Crypto, crypto));
    yield* revert.pipe(Effect.provideService(Crypto.Crypto, crypto));
    expect(uuidCalls).toBe(2);
    expect(calls.commands).toEqual([
      [
        principal,
        'crm',
        { _tag: 'AiDecideChanges', changeIds: ['change-a'], decision: 'approve', note: 'Reviewed' },
        { idempotencyKey: '01010101-0101-4101-8101-010101010101' },
      ],
      [
        principal,
        'crm',
        { _tag: 'AiRevertBatch', batchId: 'batch-a', note: 'Restore' },
        { idempotencyKey: '02020202-0202-4202-8202-020202020202' },
      ],
    ]);
  }).pipe(Effect.provide(unusedCollaborators)),
);

it.effect('keeps blank decision notes and short revert notes out of the command', () =>
  Effect.gen(function* omittedNotes() {
    yield* decideLegacy(principal, 'crm', ['change-a'], 'reject', ' ').pipe(
      Effect.provideService(Crypto.Crypto, nativeCrypto),
    );
    yield* revertLegacy(principal, 'crm', 'batch-a', ' x ').pipe(Effect.provideService(Crypto.Crypto, nativeCrypto));
    for (const command of calls.commands) {
      expect(command[2]).not.toHaveProperty('note');
    }
  }).pipe(Effect.provide(unusedCollaborators)),
);

it.effect('maps Crypto failures to AgentModuleCallError without dispatching either command', () =>
  Effect.gen(function* failedKeys() {
    const crypto: Crypto.Crypto = { ...nativeCrypto, randomUUIDv4: () => Effect.fail(cryptoFailure) };
    for (const command of [
      decideLegacy(principal, 'crm', ['change-a'], 'approve'),
      revertLegacy(principal, 'crm', 'batch-a'),
    ]) {
      const error = yield* Effect.flip(command.pipe(Effect.provideService(Crypto.Crypto, crypto)));
      expect(error).toBeInstanceOf(AgentModuleCallError);
      expect(error).toHaveProperty('cause', cryptoFailure);
      expect(error).toHaveProperty('stage', 'dispatch');
    }
    expect(calls.commands).toEqual([]);
  }).pipe(Effect.provide(unusedCollaborators)),
);
