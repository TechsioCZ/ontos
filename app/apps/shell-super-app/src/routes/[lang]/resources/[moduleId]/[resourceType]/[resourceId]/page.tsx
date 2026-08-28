/* eslint-disable no-negated-condition, unicorn/no-negated-condition -- Closed route states read most clearly as error-versus-ready branches. */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useState } from 'react';
import { attachResourceMedia, runEffectRequest } from '../../../../../../api/auth-client.ts';
import { AuthenticatedDashboardLayout } from '../../../../../shell-frame.tsx';
import { useShellControls } from '../../../../../use-shell-controls.ts';

const ResourcePage = () => {
  const { t } = useModernI18n();
  const model = useLoaderData({
    from: '/$lang/resources/$moduleId/$resourceType/$resourceId',
  });
  const [mediaState, setMediaState] = useState<'failed' | 'idle' | 'pending' | 'success'>('idle');
  const controls = useShellControls(
    model.shell.state === 'authenticated' ? model.shell : undefined,
  );
  const handleMediaAttachment = (): Promise<void> => {
    if (model.state !== 'ready') {
      return Promise.resolve();
    }
    setMediaState('pending');
    return runEffectRequest(attachResourceMedia(model.resource.ref)).then(
      () => setMediaState('success'),
      () => setMediaState('failed'),
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
              void handleMediaAttachment();
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
              {model.resource.timeline.map((entry) => (
                <li key={entry.timelineEntryId}>
                  <time dateTime={entry.occurredAt}>{entry.occurredAt}</time> — {entry.summary}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    );
  return (
    <AuthenticatedDashboardLayout
      {...(model.shell.selectedLegalEntityId === undefined
        ? {}
        : { currentLegalEntityId: model.shell.selectedLegalEntityId })}
      {...(model.state === 'ready' ? { currentModuleId: model.resource.ref.moduleId } : {})}
      currentTenantId={model.shell.identity.tenantId}
      homeCurrent={false}
      identity={{ displayName: model.shell.identity.displayName }}
      legalEntityChoices={model.shell.legalEntities.items}
      legalEntityState={model.shell.legalEntities.state}
      legalEntitySwitchFailed={controls.legalEntitySwitchFailed}
      legalEntitySwitchPending={controls.legalEntitySwitchPending}
      logoutPending={controls.logoutPending}
      navigation={model.shell.navigation.items}
      onLegalEntityChange={controls.handleLegalEntityChange}
      onLogout={controls.handleLogout}
      onSearch={controls.handleSearch}
      onTenantChange={controls.handleTenantChange}
      tenantChoices={model.shell.tenants.items}
      tenantState={model.shell.tenants.state}
      tenantSwitchFailed={controls.tenantSwitchFailed}
      tenantSwitchPending={controls.tenantSwitchPending}
      title={model.state === 'ready' ? model.resource.detail.title : t('shell.resource.title')}
    >
      {controls.logoutFailed ? (
        <StatusText aria-live="polite" showIcon status="error">
          {t('shell.auth.logout.failed')}
        </StatusText>
      ) : null}
      {content}
    </AuthenticatedDashboardLayout>
  );
};

export default ResourcePage;
