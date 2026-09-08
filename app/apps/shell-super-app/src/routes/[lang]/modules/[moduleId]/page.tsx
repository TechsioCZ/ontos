import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Predicate } from 'effect';
import { useEffect, useState } from 'react';
import type { ApprovedVerticalPageComponent } from '../../../../api/vertical-clients.ts';
import { findApprovedVerticalPageClient } from '../../../../api/vertical-clients.ts';
import { runBrowserEffect } from '../../../../runtime/browser-effect-runtime.ts';
import {
  resolveThenLoadModuleTarget,
  settleModuleEntrypointLoad,
} from '../../../module-entrypoint-loader.ts';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import type { ModuleTargetPageModel } from './page.data.ts';

type RemoteState =
  | { readonly state: 'loading' }
  | {
      readonly reason: 'incompatible' | 'timeout' | 'unavailable';
      readonly state: 'unavailable';
    }
  | { readonly Component: ApprovedVerticalPageComponent; readonly state: 'ready' };

const ResolvedTarget = ({
  model,
}: {
  readonly model: Extract<ModuleTargetPageModel, { state: 'resolved' }>;
}) => {
  const { t } = useModernI18n();
  const client = findApprovedVerticalPageClient(model.target);
  const [remote, setRemote] = useState<RemoteState>(() =>
    client === undefined ? { reason: 'incompatible', state: 'unavailable' } : { state: 'loading' },
  );

  useEffect(() => {
    if (client === undefined) {
      return;
    }
    let current = true;
    void runBrowserEffect(
      resolveThenLoadModuleTarget(Effect.succeed(model.target), () =>
        settleModuleEntrypointLoad(
          client.load,
          (loaded) =>
            Predicate.isObjectKeyword(loaded) &&
            loaded !== null &&
            'default' in loaded &&
            Predicate.isFunction(loaded.default),
        ),
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (!current) {
              return;
            }
            setRemote(
              result.state === 'ready'
                ? { Component: result.value.default, state: 'ready' }
                : result,
            );
          }),
        ),
      ),
    );
    return () => {
      current = false;
    };
  }, [client, model.target]);

  if (remote.state === 'ready') {
    return <remote.Component routeParams={model.routeParams} target={model.target} />;
  }
  return (
    <StatusText
      aria-live="polite"
      showIcon
      status={remote.state === 'loading' ? 'default' : 'error'}
    >
      {t(`shell.moduleTarget.${remote.state === 'unavailable' ? remote.reason : remote.state}`)}
    </StatusText>
  );
};

interface ModuleTargetViewProps {
  readonly initialModel: ModuleTargetPageModel;
}

export const ModuleTargetView = ({ initialModel }: ModuleTargetViewProps) => {
  const { t } = useModernI18n();
  const model = initialModel;
  const controls = useShellControls(
    model.shell.state === 'authenticated' ? model.shell : undefined,
  );
  if (model.shell.state !== 'authenticated') {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t(
            model.shell.state === 'unavailable'
              ? 'shell.dashboard.unavailable'
              : 'shell.moduleTarget.selection_required',
          )}
        </StatusText>
      </main>
    );
  }
  const content =
    model.state === 'resolved' ? (
      <ResolvedTarget model={model} />
    ) : (
      <StatusText aria-live="polite" showIcon status="error">
        {t(`shell.moduleTarget.${model.state}`)}
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
