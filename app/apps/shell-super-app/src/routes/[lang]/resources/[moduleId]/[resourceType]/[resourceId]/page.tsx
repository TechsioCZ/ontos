/* eslint-disable no-negated-condition, unicorn/no-negated-condition -- Closed route states read most clearly as error-versus-ready branches. expires: 2026-12-31. */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime, Effect, Schema } from 'effect';
import { useState } from 'react';
import { attachResourceMedia } from '../../../../../../api/auth-client.ts';
import { runBrowserEffect } from '../../../../../../runtime/browser-effect-runtime.ts';
import { ShellContentLayout } from '../../../../../shell-content-layout.tsx';
import type { ResourcePageModel } from './page.data.ts';
import { useShellControls } from '../../../../../use-shell-controls.ts';

const MediaStateSchema = Schema.Literals(['failed', 'idle', 'pending', 'success']);
type MediaState = typeof MediaStateSchema.Type;

const ResourceDetails = ({
  mediaState,
  model,
  onAttach,
}: {
  readonly mediaState: MediaState;
  readonly model: Extract<ResourcePageModel, { state: 'ready' }>;
  readonly onAttach: () => Promise<void>;
}) => {
  const { t } = useModernI18n();
  return (
    <div className="shell:grid shell:w-full shell:max-w-5xl shell:gap-8">
      <section aria-labelledby="resource-title" className="shell:grid shell:gap-4">
        <h2 className="shell:text-title-lg" id="resource-title">
          {model.resource.detail.title}
        </h2>
        <dl className="shell:grid shell:gap-3">
          {model.resource.detail.fields.map((field) => (
            <div className="shell:grid shell:gap-1" key={field.label}>
              <dt className="shell:font-semibold">{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="resource-media" className="shell:grid shell:gap-3">
        <h2 className="shell:text-title-md" id="resource-media">
          {t('shell.resource.media.title')}
        </h2>
        <Button
          disabled={!model.resource.media.enabled || mediaState === 'pending'}
          isLoading={mediaState === 'pending'}
          loadingText={t('shell.resource.media.pending')}
          onClick={() => {
            void onAttach();
          }}
          type="button"
        >
          {t('shell.resource.media.attach')}
        </Button>
        {model.resource.media.enabled ? null : (
          <StatusText status="default">
            {t(`shell.resource.media.${model.resource.media.reason}`)}
          </StatusText>
        )}
        {mediaState === 'success' || mediaState === 'failed' ? (
          <StatusText
            aria-live="polite"
            showIcon
            status={mediaState === 'success' ? 'success' : 'error'}
          >
            {t(`shell.resource.media.${mediaState}`)}
          </StatusText>
        ) : null}
      </section>
      <section aria-labelledby="resource-timeline" className="shell:grid shell:gap-3">
        <h2 className="shell:text-title-md" id="resource-timeline">
          {t('shell.resource.timeline.title')}
        </h2>
        {model.resource.projectionLagging ? (
          <StatusText aria-live="polite" showIcon status="warning">
            {t('shell.resource.timeline.lagging')}
          </StatusText>
        ) : null}
        {model.resource.timeline.length === 0 ? (
          <StatusText status="default">{t('shell.resource.timeline.empty')}</StatusText>
        ) : (
          <ol className="shell:grid shell:gap-3">
            {model.resource.timeline.map((entry) => {
              const occurredAt = DateTime.formatIso(entry.occurredAt);
              return (
                <li key={entry.timelineEntryId}>
                  <time dateTime={occurredAt}>{occurredAt}</time> — {entry.summary}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
};

const ResourcePage = () => {
  const { t } = useModernI18n();
  const model = useLoaderData({
    from: '/$lang/resources/$moduleId/$resourceType/$resourceId',
  });
  const [mediaState, setMediaState] = useState<MediaState>('idle');
  const controls = useShellControls(
    model.shell.state === 'authenticated' ? model.shell : undefined,
  );
  const handleMediaAttachment = (): Promise<void> => {
    if (model.state !== 'ready') {
      return Promise.resolve();
    }
    setMediaState('pending');
    return runBrowserEffect(
      attachResourceMedia(model.resource.ref).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              void error;
              setMediaState('failed');
            }),
          onSuccess: () => Effect.sync(() => setMediaState('success')),
        }),
      ),
    );
  };
  if (model.shell.state !== 'authenticated') {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t(
            model.shell.state === 'unavailable'
              ? 'shell.dashboard.unavailable'
              : 'shell.resource.selection_required',
          )}
        </StatusText>
      </main>
    );
  }
  const content =
    model.state !== 'ready' ? (
      <StatusText aria-live="polite" showIcon status="error">
        {t(`shell.resource.${model.state}`)}
      </StatusText>
    ) : (
      <ResourceDetails mediaState={mediaState} model={model} onAttach={handleMediaAttachment} />
    );
  return (
    <ShellContentLayout
      controls={controls}
      shell={model.shell}
      {...(model.state === 'ready' ? { currentModuleId: model.resource.ref.moduleId } : {})}
      title={model.state === 'ready' ? model.resource.detail.title : t('shell.resource.title')}
    >
      {content}
    </ShellContentLayout>
  );
};

export default ResourcePage;
