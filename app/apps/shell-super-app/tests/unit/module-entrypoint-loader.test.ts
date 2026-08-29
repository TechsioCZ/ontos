// @effect-diagnostics lazyEffect:off
import { expect, test } from '@rstest/core';
import { Effect, Schema } from 'effect';
import {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
  TrustedPrincipalContextSchema,
  defineTenantModuleEntrypoint,
} from '@app/core-runtime';
import type {
  ModuleEntrypointDescriptor,
  ModuleEntrypointGatewayService,
  ModuleStateGateError,
  ModuleStateSnapshot,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import {
  loadModuleEntrypointComposition,
  resolveThenLoadModuleTarget,
} from '../../src/routes/module-entrypoint-loader.ts';

const trustedContext: TrustedPrincipalContext = {
  authMethod: 'session',
  principalId: '10000000-0000-4000-8000-000000000001',
  tenantId: '20000000-0000-4000-8000-000000000001',
};

interface FakeGatewayOptions {
  readonly deniedEntrypointKeys?: ReadonlySet<string>;
  readonly onPrepare?: (entrypoints: readonly ModuleEntrypointDescriptor[]) => void;
  readonly unavailable?: boolean;
}

const makeFakeGateway = (options: FakeGatewayOptions = {}): ModuleEntrypointGatewayService => {
  const check: ModuleEntrypointGatewayService['check'] = (snapshot, entrypoint) => {
    if (!snapshot.entrypointKeys.includes(entrypoint.entrypointKey)) {
      return Effect.fail(
        new ModuleStateCheckUnavailableError({
          code: 'module_state_check_unavailable',
          reason: 'Module state could not be checked safely',
        }),
      );
    }
    return options.deniedEntrypointKeys?.has(entrypoint.entrypointKey) === true
      ? Effect.fail(
          new ModuleStateDeniedError({
            code: 'module_state_denied',
            reason: 'The module entrypoint is unavailable in the current module state',
          }),
        )
      : Effect.void;
  };
  const prepareSnapshot: ModuleEntrypointGatewayService['prepareSnapshot'] = (
    context,
    entrypoints,
  ) => {
    options.onPrepare?.(entrypoints);
    if (options.unavailable === true || context.tenantId.length === 0) {
      return Effect.fail(
        new ModuleStateCheckUnavailableError({
          code: 'module_state_check_unavailable',
          reason: 'Module state could not be checked safely',
        }),
      );
    }
    const snapshot: ModuleStateSnapshot = Object.freeze({
      entrypointKeys: Object.freeze(entrypoints.map(({ entrypointKey }) => entrypointKey)),
      moduleKeys: Object.freeze(
        [...new Set(entrypoints.map(({ moduleKey }) => moduleKey))].toSorted(),
      ),
      tenantId: context.tenantId,
    });
    return Effect.succeed(snapshot);
  };
  const gateway: ModuleEntrypointGatewayService = {
    check,
    prepareSnapshot,
    prepareSnapshotInput: (context, entrypoints) =>
      Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(context).pipe(
        Effect.mapError(
          () =>
            new ModuleStateCheckUnavailableError({
              code: 'module_state_check_unavailable',
              reason: 'Module state could not be checked safely',
            }),
        ),
        Effect.flatMap((trusted) => prepareSnapshot(trusted, entrypoints)),
      ),
    run: (input) =>
      check(input.snapshot, input.entrypoint).pipe(
        Effect.andThen(input.authorize),
        Effect.andThen(Effect.suspend(input.load)),
      ),
  };
  return gateway;
};

const page = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'inventory.stock.page.orders',
  moduleKey: 'inventory.stock',
  role: 'page',
});
const component = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'inventory.stock.component.summary',
  moduleKey: 'inventory.stock',
  role: 'public_component',
});

test('prepares one complete trusted composition and invokes allowed lazy loaders', async () => {
  let batches = 0;
  let loads = 0;
  const gateway = makeFakeGateway({
    onPrepare: (entrypoints) => {
      batches += 1;
      expect(entrypoints).toEqual([page, component]);
    },
  });
  const result = await Effect.runPromise(
    loadModuleEntrypointComposition(
      gateway,
      trustedContext,
      [page, component].map((entrypoint) => ({
        authorize: Effect.void,
        entrypoint,
        load: () =>
          Effect.sync(() => {
            loads += 1;
            return `loaded-${loads}`;
          }),
      })),
    ),
  );
  expect(result).toEqual(['loaded-1', 'loaded-2']);
  expect(batches).toBe(1);
});

test('checks the complete composition before authorizing or invoking any loader', async () => {
  let authorizations = 0;
  let loads = 0;
  const gateway = makeFakeGateway({
    deniedEntrypointKeys: new Set([component.entrypointKey]),
  });
  await expect(
    Effect.runPromise(
      loadModuleEntrypointComposition(
        gateway,
        trustedContext,
        [page, component].map((entrypoint) => ({
          authorize: Effect.sync(() => {
            authorizations += 1;
          }),
          entrypoint,
          load: () =>
            Effect.sync(() => {
              loads += 1;
              return loads;
            }),
        })),
      ),
    ),
  ).rejects.toMatchObject({ _tag: 'ModuleStateDeniedError' });
  expect(authorizations).toBe(0);
  expect(loads).toBe(0);
});

type RemoteLoadUnavailable = Readonly<{ readonly _tag: 'RemoteLoadUnavailable' }>;
type FakeUnavailableUiState = 'forbidden' | 'unavailable';

const mapFakeUnavailableUiState = (
  error: ModuleStateGateError | RemoteLoadUnavailable,
): FakeUnavailableUiState => {
  switch (error._tag) {
    case 'ModuleStateDeniedError': {
      return 'forbidden';
    }
    case 'ModuleStateCheckUnavailableError':
    case 'RemoteLoadUnavailable': {
      return 'unavailable';
    }
    default: {
      return error;
    }
  }
};

test('preserves typed gate and remote-load failures for exhaustive UI mapping', async () => {
  const gateFailure = await Effect.runPromise(
    Effect.flip(
      loadModuleEntrypointComposition(makeFakeGateway({ unavailable: true }), trustedContext, [
        { authorize: Effect.void, entrypoint: page, load: () => Effect.succeed('unreachable') },
      ]),
    ),
  );
  expect(mapFakeUnavailableUiState(gateFailure)).toBe('unavailable');

  const remoteFailure = await Effect.runPromise(
    Effect.flip(
      loadModuleEntrypointComposition(makeFakeGateway(), trustedContext, [
        {
          authorize: Effect.void,
          entrypoint: page,
          load: () => Effect.fail<RemoteLoadUnavailable>({ _tag: 'RemoteLoadUnavailable' }),
        },
      ]),
    ),
  );
  expect(remoteFailure).toEqual({ _tag: 'RemoteLoadUnavailable' });
  expect(mapFakeUnavailableUiState(remoteFailure)).toBe('unavailable');
});

test.each(['selection_required', 'not_found', 'forbidden', 'unavailable'] as const)(
  'never invokes a remote loader after a %s target resolution',
  async (outcome) => {
    let loads = 0;
    await expect(
      Effect.runPromise(
        resolveThenLoadModuleTarget(Effect.fail({ outcome }), () =>
          Effect.sync(() => {
            loads += 1;
            return 'unreachable';
          }),
        ),
      ),
    ).rejects.toEqual({ outcome });
    expect(loads).toBe(0);
  },
);

test('invokes the lazy registry only after receiving an approved target', async () => {
  let loads = 0;
  const target = { appId: 'inventory-app', componentKey: 'inventory.stock.page' };
  const result = await Effect.runPromise(
    resolveThenLoadModuleTarget(Effect.succeed(target), (approved) =>
      Effect.sync(() => {
        loads += 1;
        return approved.componentKey;
      }),
    ),
  );
  expect(result).toBe('inventory.stock.page');
  expect(loads).toBe(1);
});
