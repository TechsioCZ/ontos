import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { CatchBoundary, useLoaderData, useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Duration, Effect, Predicate, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';

import type { ResolvedModuleTarget } from '../../../../../shared/browser-api.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  moduleEntrypointLoadIdentity,
  ModuleEntrypointNamespaceSchema,
  pinBrowserModuleTarget,
  settleModuleEntrypointLoads,
} from '../../../module-entrypoint-loader.ts';
import type { ModuleEntrypointNamespace } from '../../../module-entrypoint-loader.ts';
import { ModuleRenderFailure } from '../../../module-render-failure.tsx';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import type { ModuleTargetPageModel } from './module-page-model.ts';

type ApprovedModulePageComponent = ComponentType<{
  readonly routeParams: Readonly<Record<string, string>>;
  readonly target: ResolvedModuleTarget;
}>;

const ApprovedModulePageComponentSchema = Schema.declare<ApprovedModulePageComponent>(
  (value): value is ApprovedModulePageComponent => Predicate.isFunction(value),
);
const RemotePageModuleSchema = Schema.Struct({ default: ApprovedModulePageComponentSchema });

type RemoteState =
  | { readonly state: 'loading' }
  | {
      readonly reason: 'incompatible' | 'reload_required' | 'timeout' | 'unavailable';
      readonly state: 'unavailable';
    }
  | {
      readonly Component: ApprovedModulePageComponent;
      readonly state: 'ready';
    };

const browserFederationRuntime =
  import.meta.env.MODERN_TARGET === 'browser'
    ? Effect.tryPromise(() => import('@module-federation/modern-js-v3/runtime')).pipe(Effect.timeout('5 seconds'))
    : Effect.interrupt;

const ResolvedTarget = ({ model }: { readonly model: Extract<ModuleTargetPageModel, { state: 'resolved' }> }) => {
  const { t } = useModernI18n();
  const [loadedTarget, setLoadedTarget] = useState<{
    readonly result: RemoteState;
    readonly target: ResolvedModuleTarget;
  }>({ result: { state: 'loading' }, target: model.target });
  const remote: RemoteState = loadedTarget.target === model.target ? loadedTarget.result : { state: 'loading' };

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    if (import.meta.env.MODERN_TARGET === 'browser') {
      const load = Effect.flatMap(pinBrowserModuleTarget(model.target, document), () => {
        if (!current || controller.signal.aborted) {
          return Effect.interrupt;
        }
        return browserFederationRuntime;
      }).pipe(
        Effect.flatMap(({ getInstance }) => {
          if (!current || controller.signal.aborted) {
            return Effect.interrupt;
          }
          const host = getInstance((instance) => instance.name === 'shellSuperApp');
          if (host === undefined || host === null) {
            return Effect.succeed<RemoteState>({ reason: 'unavailable', state: 'unavailable' });
          }
          const { federation } = model.target;
          if (federation.remoteName === host.name) {
            return Effect.succeed<RemoteState>({ reason: 'incompatible', state: 'unavailable' });
          }
          return settleModuleEntrypointLoads([
            {
              contract: RemotePageModuleSchema,
              identity: model.target,
              load: () =>
                Effect.tryPromise(() => {
                  host.registerRemotes([{ entry: federation.manifest.url, name: federation.remoteName }]);
                  return host.loadRemote<ModuleEntrypointNamespace>(
                    `${federation.remoteName}/${federation.expose.slice(2)}`,
                  );
                }).pipe(
                  // Caller deadlines belong to the scheduler; uncancellable SDK work keeps its physical slot.
                  Effect.timeoutOrElse({ duration: Duration.infinity, orElse: () => Effect.never }),
                  Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
                ),
              loadIdentity: moduleEntrypointLoadIdentity(model.target),
            },
          ]).pipe(
            Effect.map(([result]): RemoteState => {
              if (result === undefined) {
                return { reason: 'unavailable', state: 'unavailable' };
              }
              if (result.state === 'unavailable') {
                return result;
              }
              return { Component: result.value.default, state: 'ready' };
            }),
          );
        }),
        Effect.catchTags({
          BrowserModuleRevisionConflict: () =>
            Effect.succeed<RemoteState>({ reason: 'reload_required', state: 'unavailable' }),
          TimeoutError: () => Effect.succeed<RemoteState>({ reason: 'timeout', state: 'unavailable' }),
          UnknownError: () => Effect.succeed<RemoteState>({ reason: 'unavailable', state: 'unavailable' }),
        }),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (!current) {
              return;
            }
            setLoadedTarget({ result, target: model.target });
          }),
        ),
      );
      void browserRuntime.runPromiseExit(load, { signal: controller.signal });
    }
    return () => {
      current = false;
      controller.abort();
    };
  }, [model.target]);

  if (remote.state === 'ready') {
    return <remote.Component routeParams={model.routeParams} target={model.target} />;
  }
  return (
    <StatusText aria-live="polite" showIcon status={remote.state === 'loading' ? 'default' : 'error'}>
      {t(`shell.moduleTarget.${remote.state === 'unavailable' ? remote.reason : remote.state}`)}
    </StatusText>
  );
};

interface ModuleTargetViewProps {
  readonly initialModel: ModuleTargetPageModel;
}

// Framework integration adapter: raw error and boundary.reset are intentionally unused.
const ModuleRenderError = () => {
  const navigate = useNavigate();
  const handleReload = () => {
    void browserRuntime.runPromiseExit(
      Effect.tryPromise(() => navigate({ reloadDocument: true, to: '.' })).pipe(Effect.timeout('10 seconds')),
    );
  };
  return <ModuleRenderFailure onReload={handleReload} />;
};

export const ModuleTargetView = ({ initialModel }: ModuleTargetViewProps) => {
  const { t } = useModernI18n();
  const model = initialModel;
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  if (model.shell.state !== 'authenticated') {
    let message = 'shell.moduleTarget.selection_required';
    if (model.shell.state === 'reload_required') {
      message = 'shell.moduleTarget.reload_required';
    } else if (model.shell.state === 'unavailable') {
      message = 'shell.dashboard.unavailable';
    }
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t(message)}
        </StatusText>
      </main>
    );
  }
  const status = controls.reloadRequired ? 'reload_required' : model.state;
  const content =
    model.state === 'resolved' && !controls.reloadRequired ? (
      <CatchBoundary
        errorComponent={ModuleRenderError}
        getResetKey={() => moduleEntrypointLoadIdentity(model.target).result}
      >
        <ResolvedTarget model={model} />
      </CatchBoundary>
    ) : (
      <StatusText aria-live="polite" showIcon status="error">
        {t(`shell.moduleTarget.${status}`)}
      </StatusText>
    );
  return (
    <ShellContentLayout
      controls={controls}
      shell={model.shell}
      {...(model.state === 'resolved' ? { currentModuleId: model.target.moduleId } : {})}
    >
      {content}
    </ShellContentLayout>
  );
};

const ModuleTargetPage = () => {
  const initialModel: ModuleTargetPageModel = useLoaderData({
    from: '/$lang/modules/$moduleId',
    structuralSharing: false,
  });
  return <ModuleTargetView initialModel={initialModel} />;
};

export default ModuleTargetPage;
