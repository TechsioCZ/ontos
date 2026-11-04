/* eslint-disable no-negated-condition, unicorn/no-negated-condition -- Closed route states read most clearly as error-versus-ready branches. expires: 2026-12-31. */
import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData, useParams } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime, Effect, Schema } from 'effect';
import { useState } from 'react';

import { ShellReloadRequiredProblemSchema } from '../../../../../../../shared/api.ts';
import { attachResourceMedia } from '../../../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../../../runtime/browser-effect-runtime.ts';
import type { ShellNavigationItem } from '../../../../../../../shared/api.ts';
import { ShellContentLayout } from '../../../../../shell-content-layout.tsx';
import { buildShellNavigation, ShellRouteLink } from '../../../../../shell-frame.tsx';
import { recordAgendaPaths, shellSearchPresentationContext } from '../../../../../shell-search-resource-types.ts';
import { ShellStatusPanel, shellStatusTitleKey } from '../../../../../shell-status-panel.tsx';
import { SignInRedirect } from '../../../../../sign-in-redirect.tsx';
import { useShellControls } from '../../../../../use-shell-controls.ts';
import type { ResourcePageModel } from './resource-page-model.ts';

const MediaStateSchema = Schema.Literals(['failed', 'idle', 'pending', 'success']);
type MediaState = typeof MediaStateSchema.Type;
type ReadyResourceModel = Extract<ResourcePageModel, { state: 'ready' }>;
type AuthenticatedShell = Extract<ResourcePageModel['shell'], { readonly state: 'authenticated' }>;

/** The document's composed navigation, when it has one; the Shell reads record destinations from it. */
const composedSearchContextOf = (shell: AuthenticatedShell) => {
  const navigation = shell.navigation.state === 'available' ? shell.navigation : undefined;
  return shellSearchPresentationContext(navigation?.items ?? [], navigation?.recordDestinations ?? []);
};

const ResourceDetails = ({
  mediaState,
  model,
  onAttach,
}: {
  readonly mediaState: MediaState;
  readonly model: ReadyResourceModel;
  readonly onAttach: () => void;
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
          onClick={onAttach}
          type="button"
        >
          {t('shell.resource.media.attach')}
        </Button>
        {model.resource.media.enabled ? null : (
          <StatusText status="default">{t(`shell.resource.media.${model.resource.media.reason}`)}</StatusText>
        )}
        {mediaState === 'success' || mediaState === 'failed' ? (
          <StatusText aria-live="polite" showIcon status={mediaState === 'success' ? 'success' : 'error'}>
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

/**
 * When the Shell cannot show a record itself, the agendas that list it stay one click away: the ones its type names
 * (also Shell pages, e.g. people administration for a person), else every agenda of the owning module. Only
 * destinations in the person's own navigation appear, so a link is shown only when it may be opened.
 */
const OwningAgendaLinks = ({
  agendaPaths,
  moduleId,
  navigation,
}: {
  readonly agendaPaths: readonly string[] | undefined;
  readonly moduleId: string;
  readonly navigation: readonly ShellNavigationItem[];
}) => {
  const { language, t } = useModernI18n();
  const agendas = agendaPaths === undefined ? undefined : new Set(agendaPaths);
  const links = buildShellNavigation(
    {
      language: language ?? '',
      navigation: navigation.filter((item) =>
        agendas === undefined ? item.moduleId === moduleId : agendas.has(item.href ?? ''),
      ),
      unavailableDeployments: [],
    },
    t,
  ).groups.flatMap((group) => group.links.filter(({ enabled, href }) => enabled && href !== null));
  if (links.length === 0) {
    return null;
  }
  return (
    <nav aria-labelledby="resource-agendas" className="grid w-full max-w-2xl gap-150">
      <h2 className="font-semibold text-base" id="resource-agendas">
        {t('shell.resource.open_in_agenda')}
      </h2>
      <ul className="grid gap-150 md:grid-cols-2">
        {links.map((link) => (
          <li key={link.key}>
            <LinkButton
              as={ShellRouteLink}
              block
              className="justify-start hover:bg-overlay"
              icon={link.icon}
              size="sm"
              theme="unstyled"
              to={link.href ?? '/'}
              variant="secondary"
            >
              {link.label}
            </LinkButton>
          </li>
        ))}
      </ul>
    </nav>
  );
};

/**
 * A record type the Shell admits but cannot show itself. The response says only that the catalog has no detail
 * binding; it says nothing about whether this record exists. Name the limitation and keep real navigation.
 */
const UnsupportedDetail = ({
  agendaPaths,
  moduleId,
  navigation,
}: {
  readonly agendaPaths: readonly string[] | undefined;
  readonly moduleId: string;
  readonly navigation: readonly ShellNavigationItem[];
}) => {
  const { t } = useModernI18n();
  return (
    <>
      <section className="ontos-card flex w-full max-w-2xl flex-col items-start gap-200 rounded-lg border border-border-primary/60 bg-base p-300">
        <p className="text-sm">{t('shell.resource.detail_not_supported')}</p>
        <LinkButton as={LocalizedLink} icon="icon-[mdi--home-outline]" size="sm" theme="solid" to="/" variant="primary">
          {t('shell.recovery.home')}
        </LinkButton>
      </section>
      <OwningAgendaLinks agendaPaths={agendaPaths} moduleId={moduleId} navigation={navigation} />
    </>
  );
};

const ResourcePage = () => {
  const { t } = useModernI18n();
  const model = useLoaderData({
    from: '/$lang/resources/$moduleId/$resourceType/$resourceId',
  });
  const { moduleId, resourceId, resourceType } = useParams({
    from: '/$lang/resources/$moduleId/$resourceType/$resourceId',
  });
  const [mediaState, setMediaState] = useState<MediaState>('idle');
  const [attachmentReloadRequired, setAttachmentReloadRequired] = useState(false);
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  const handleMediaAttachment = (ref: ReadyResourceModel['resource']['ref']) => {
    if (
      model.shell.state !== 'authenticated' ||
      model.shell.compositionRevision === undefined ||
      controls.reloadRequired ||
      attachmentReloadRequired
    ) {
      return;
    }
    setMediaState('pending');
    void browserRuntime.runPromise(
      attachResourceMedia({ ...ref, compositionRevision: model.shell.compositionRevision }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              if (Schema.is(ShellReloadRequiredProblemSchema)(error)) {
                setAttachmentReloadRequired(true);
              }
              setMediaState('failed');
            }),
          onSuccess: () => Effect.sync(() => setMediaState('success')),
        }),
      ),
    );
  };
  if (
    model.state === 'reload_required' ||
    model.shell.state === 'reload_required' ||
    controls.reloadRequired ||
    attachmentReloadRequired
  ) {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <ShellStatusPanel messageKey="shell.moduleTarget.reload_required" status="unavailable" />
      </main>
    );
  }
  if (model.shell.state === 'anonymous') {
    return <SignInRedirect reason={model.shell.reason} />;
  }
  if (model.shell.state === 'unavailable') {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <ShellStatusPanel messageKey="shell.dashboard.unavailable" status="unavailable" />
      </main>
    );
  }
  if (model.shell.state !== 'authenticated') {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t('shell.resource.selection_required')}
        </StatusText>
      </main>
    );
  }
  const recordRef = { moduleId, resourceId, resourceType };
  const agendaPaths = recordAgendaPaths(recordRef, composedSearchContextOf(model.shell));
  // Only an admitted, authorized detail response proves the record and may render its title, fields or actions.
  // A search history title is navigation input, never evidence that a failed, missing or unsupported read found a record.
  const detailNotSupported = model.state === 'unavailable' && model.detailSupport === 'not_supported';
  const closedContent = detailNotSupported ? (
    <UnsupportedDetail agendaPaths={agendaPaths} moduleId={moduleId} navigation={model.shell.navigation.items} />
  ) : (
    // Distinct states: forbidden (lock), not found (search), temporarily unavailable (retry).
    <>
      <ShellStatusPanel messageKey={`shell.resource.${model.state}`} status={model.state} />
      {model.state === 'forbidden' ? null : (
        <OwningAgendaLinks agendaPaths={agendaPaths} moduleId={moduleId} navigation={model.shell.navigation.items} />
      )}
    </>
  );
  const content =
    model.state !== 'ready' ? (
      closedContent
    ) : (
      <ResourceDetails
        mediaState={mediaState}
        model={model}
        onAttach={() => handleMediaAttachment(model.resource.ref)}
      />
    );
  let pageTitle: string;
  if (model.state === 'ready') {
    pageTitle = model.resource.detail.title;
  } else if (detailNotSupported) {
    pageTitle = t('shell.resource.detail_not_supported_title');
  } else {
    pageTitle = t(shellStatusTitleKey(model.state, 'recordMissing'));
  }
  return (
    <ShellContentLayout
      controls={controls}
      shell={model.shell}
      {...(model.state === 'ready' ? { currentModuleId: model.resource.ref.moduleId } : {})}
      title={pageTitle}
    >
      {content}
    </ShellContentLayout>
  );
};

export default ResourcePage;
