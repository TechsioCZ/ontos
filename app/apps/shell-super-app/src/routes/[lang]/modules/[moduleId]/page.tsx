import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { ModulePageSkeleton } from '../../../module-page-skeleton.tsx';
import { modulePageProps, peekRemotePage, prepareModulePage, remotePageIdentity } from '../../../remote-page-loader.ts';
import type { RemoteState } from '../../../remote-page-loader.ts';
import { ShellStatusPanel, shellStatusTitleKey } from '../../../shell-status-panel.tsx';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { SignInRedirect } from '../../../sign-in-redirect.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import type { ModuleTargetPageModel, ResolvedModulePageModel } from './module-page-model.ts';

/** A cold page (first document load, or a navigation whose budget ran out) waits this long for code and data. */
const COLD_PREPARE_BUDGET = '10 seconds';

const subscribeNever = () => () => {
  // Read once per render: the page reveals when its preparation settles, not when its code alone arrives.
};
const notLoaded: RemoteState = { state: 'loading' };

/**
 * Renders a resolved module page. A navigation prepares the page (code and primary data) before the router reveals
 * it, so the module is found loaded here and renders real content in the first commit. A cold page (the first
 * document load: the server never renders remote code) shows one neutral skeleton, the same markup on the server and
 * at hydration, until the same preparation settles, then the page replaces it once.
 */
export const ResolvedTarget = ({ model }: { readonly model: ResolvedModulePageModel }) => {
  const { t } = useModernI18n();
  // A loader re-run returns an equal target as a new object. Compare by remote page, so the mounted page is kept
  // instead of remounting (which repeated all of its reads).
  const identity = remotePageIdentity(model.target);
  // Hydration uses the server answer (not loaded), so the markup matches the server's skeleton.
  const loaded = useSyncExternalStore(
    subscribeNever,
    () => Option.getOrElse(peekRemotePage(model.target), () => notLoaded),
    () => notLoaded,
  );
  const [prepared, setPrepared] = useState<{ readonly identity: string; readonly result: RemoteState }>();
  const props = modulePageProps(model.shell, model.routeParams, model.search);
  const remote = prepared?.identity === identity ? prepared.result : loaded;
  const needsPreparation = remote.state === 'loading';

  useEffect(() => {
    if (!needsPreparation) {
      return;
    }
    const controller = new AbortController();
    void browserRuntime.runPromiseExit(
      prepareModulePage(model.target, props, globalThis.location.pathname, COLD_PREPARE_BUDGET).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            setPrepared({
              identity: remotePageIdentity(model.target),
              result: Option.getOrElse(
                Option.orElse(result, () => peekRemotePage(model.target)),
                (): RemoteState => ({ reason: 'timeout', state: 'unavailable' }),
              ),
            });
          }),
        ),
      ),
      { signal: controller.signal },
    );
    return () => controller.abort();
  }, [needsPreparation, model.target, props]);

  if (remote.state === 'ready') {
    return <remote.Component {...props} target={model.target} />;
  }
  if (remote.state === 'loading') {
    return <ModulePageSkeleton />;
  }
  return (
    <StatusText aria-live="polite" showIcon status="error">
      {t(`shell.moduleTarget.${remote.reason}`)}
    </StatusText>
  );
};

interface ModuleTargetViewProps {
  readonly initialModel: ModuleTargetPageModel;
}

export const ModuleTargetView = ({ initialModel }: ModuleTargetViewProps) => {
  const { t } = useModernI18n();
  const model = initialModel;
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  // A protected module opened without a live session goes to sign-in, and sign-in returns here.
  if (model.shell.state === 'anonymous') {
    return <SignInRedirect reason={model.shell.reason} />;
  }
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
      <ResolvedTarget model={model} />
    ) : (
      <ShellStatusPanel status={status} />
    );
  return (
    <ShellContentLayout
      controls={controls}
      shell={model.shell}
      {...(model.state === 'resolved'
        ? { currentEntrypointKey: model.target.entrypointKey, currentModuleId: model.target.moduleId }
        : {
            title: t(shellStatusTitleKey(status)),
          })}
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
