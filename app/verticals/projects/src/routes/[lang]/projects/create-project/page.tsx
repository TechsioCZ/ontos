import {
  ReadProjectAuthenticationProblemSchema,
  ReadProjectForbiddenProblemSchema,
  ReadProjectNotFoundProblemSchema,
} from '../../../../../shared/apis/read-project.ts';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { useNavigate, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Helmet } from '@modern-js/runtime/head';
import { pageDataScopeKey, pageDataTenantScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime';
import { DateTime, Effect, Fiber, Option, Random, Schema } from 'effect';
import { Url } from 'effect/http';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ProjectUuidSchema } from '../../../../../shared/domain/project.ts';
import type { Project } from '../../../../../shared/domain/project.ts';
import { executeFreshReadProject } from '../../../../api/projects-client.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { projectsI18nResources } from '../../../../i18n/resources';
import { CreateProjectForm } from './create-project-form.tsx';
import '../../../index.css';

const projectDetailKey = 'projects.pages.projectDetail';

type ProjectId = Project['projectId'];

/** The Project as the fresh read returns it: Core's field projection may omit governed principal fields. */
export type ProjectTargetRecord = Effect.Success<ReturnType<typeof executeFreshReadProject>>;

/** What a copied projects URL names: one exact Project, nothing, or an explicit invalid selection. */
export type ProjectSearchTarget =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'id'; readonly projectId: ProjectId };

/** One Schema boundary owns the native query-string reading; no route code reads single parameters by hand. */
const ProjectSearchQuerySchema = Schema.RecordFromUrlParams.pipe(
  Schema.decodeTo(
    Schema.Struct({
      projectId: Schema.optionalKey(ProjectUuidSchema),
    }),
  ),
);

/** The native query selection of the page (`?projectId=`); an invalid value is explicit, never a fallback. */
export const projectSearchTargetFromSearchStr = (searchStr: string): ProjectSearchTarget =>
  Option.match(
    Schema.decodeOption(ProjectSearchQuerySchema)(Url.urlParams(new URL(searchStr, 'https://projects.invalid/'))),
    {
      onNone: (): ProjectSearchTarget => ({ kind: 'invalid' }),
      onSome: ({ projectId }): ProjectSearchTarget =>
        projectId === undefined ? { kind: 'absent' } : { kind: 'id', projectId },
    },
  );

/** The ordinary create form is the page only when the URL names no target at all. */
export const projectPageMode = (target: ProjectSearchTarget): 'create' | 'target' =>
  target.kind === 'absent' ? 'create' : 'target';

/** The trusted actor scope a copied target must be revalidated against: a company session or a verified tenant. */
export type ProjectTargetScope =
  /** A company session: the selected company is part of the request identity. */
  | {
      readonly kind: 'company';
      readonly legalEntityId: string;
      readonly principalId: string;
      readonly tenantId: string;
    }
  /** A verified tenant-only session: Projects are tenant-scoped, so no company is required or invented. */
  | {
      readonly kind: 'tenant';
      readonly principalId: string;
      readonly tenantId: string;
    };

/**
 * The trusted scope a copied target must be revalidated against. A company context keeps its company in the
 * request identity; a verified tenant context is tenant-scoped and never fabricates one. No trustworthy identity
 * means no scope, so the page shows its non-disclosing scope notice instead of reading.
 */
export const projectTargetScopeOf = ({
  context,
  tenantContext,
}: Pick<ModulePageProps, 'context' | 'tenantContext'>): ProjectTargetScope | undefined => {
  if (context !== undefined) {
    return context.tenantId !== '' && context.legalEntityId !== '' && context.principalId !== ''
      ? {
          kind: 'company',
          legalEntityId: context.legalEntityId,
          principalId: context.principalId,
          tenantId: context.tenantId,
        }
      : undefined;
  }
  return tenantContext !== undefined && tenantContext.tenantId !== '' && tenantContext.principalId !== ''
    ? { kind: 'tenant', principalId: tenantContext.principalId, tenantId: tenantContext.tenantId }
    : undefined;
};

export interface ProjectTargetRequest {
  /** A retry keeps the same target/scope identity but starts a fresh read. */
  readonly attempt?: number;
  readonly projectId: ProjectId;
  readonly scope: ProjectTargetScope;
}

export const projectTargetScopeKey = (scope: ProjectTargetScope): string =>
  scope.kind === 'company'
    ? ['company', scope.tenantId, scope.legalEntityId, scope.principalId].join('\u0000')
    : ['tenant', scope.tenantId, scope.principalId].join('\u0000');

export const projectTargetRequestKey = ({ projectId, scope }: ProjectTargetRequest): string =>
  [projectTargetScopeKey(scope), projectId].join('\u0000');

export type ProjectTargetState =
  | { readonly projectId: ProjectId; readonly status: 'loading' | 'forbidden' | 'missing' | 'unavailable' }
  | { readonly project: ProjectTargetRecord; readonly projectId: ProjectId; readonly status: 'ready' };

export interface ProjectTargetNotice {
  readonly labelKey: string;
  readonly retry: boolean;
  readonly tone: 'error' | 'warning';
}

/** The honest, non-disclosing notice of a copied target that is not currently available to this reader. */
export const projectTargetNotice = (state: ProjectTargetState): ProjectTargetNotice | undefined => {
  if (state.status === 'loading' || state.status === 'ready') {
    return undefined;
  }
  if (state.status === 'forbidden') {
    return { labelKey: `${projectDetailKey}.forbidden`, retry: false, tone: 'error' };
  }
  if (state.status === 'missing') {
    return { labelKey: `${projectDetailKey}.missing`, retry: true, tone: 'warning' };
  }
  return { labelKey: `${projectDetailKey}.unavailable`, retry: true, tone: 'warning' };
};

export const projectInvalidNotice: ProjectTargetNotice = {
  labelKey: `${projectDetailKey}.invalid`,
  retry: false,
  tone: 'warning',
};

export const projectScopeNotice: ProjectTargetNotice = {
  labelKey: `${projectDetailKey}.scopeUnavailable`,
  retry: false,
  tone: 'warning',
};

/** Only a denied, missing or otherwise failed read is a notice; a ready record is never reclassified. */
export type ProjectTargetFailure = Effect.Error<ReturnType<typeof executeFreshReadProject>>;

export const projectTargetFailureStatus = (failure: ProjectTargetFailure): 'forbidden' | 'missing' | 'unavailable' => {
  if (
    Schema.is(ReadProjectForbiddenProblemSchema)(failure) ||
    Schema.is(ReadProjectAuthenticationProblemSchema)(failure)
  ) {
    return 'forbidden';
  }
  return Schema.is(ReadProjectNotFoundProblemSchema)(failure) ? 'missing' : 'unavailable';
};

/**
 * The exact response is the only record this page may show. A response for another tenant or another Project is a
 * contract failure, not a reason to display adjacent data or fall back to a list row. The reader principal is part
 * of the request identity, and a superseded read can never publish, so another principal's response never applies.
 */
export const projectTargetStateOf = (
  project: ProjectTargetRecord,
  request: ProjectTargetRequest,
): ProjectTargetState =>
  project.projectId === request.projectId && project.tenantId === request.scope.tenantId
    ? { project, projectId: request.projectId, status: 'ready' }
    : { projectId: request.projectId, status: 'unavailable' };

const readProjectTarget = Effect.fn('ProjectsPage.readTarget')(function* readProjectTarget(projectId: ProjectId) {
  const token = yield* Random.nextInt;
  return yield* executeFreshReadProject({ projectId }, `projects:target:${token}`);
});

const interruptProjectTargetRead = (effect: Effect.Effect<void>): (() => void) => {
  const fiber = browserRuntime.runFork(effect);
  return () => {
    browserRuntime.runFork(Fiber.interrupt(fiber));
  };
};

type ProjectTargetApply = (request: ProjectTargetRequest, state: ProjectTargetState) => void;
type ProjectTargetClassify<Failure> = (failure: Failure) => 'forbidden' | 'missing' | 'unavailable';
type ProjectTargetRead<Failure> = (projectId: ProjectId) => Effect.Effect<ProjectTargetRecord, Failure>;
type ProjectTargetRun = (effect: Effect.Effect<void>) => () => void;

/**
 * One fresh, cancellable target read: each update interrupts the previous lookup, and only the current epoch may
 * publish a state. It never reads, refreshes or mutates the page's create draft or any owner dataset.
 */
export class ProjectTargetController<Failure> {
  readonly #apply: ProjectTargetApply;
  readonly #classify: ProjectTargetClassify<Failure>;
  readonly #read: ProjectTargetRead<Failure>;
  readonly #run: ProjectTargetRun;
  #epoch = 0;
  #interrupt: (() => void) | null = null;

  constructor(
    apply: ProjectTargetApply,
    classify: ProjectTargetClassify<Failure>,
    read: ProjectTargetRead<Failure>,
    run: ProjectTargetRun,
  ) {
    this.#apply = apply;
    this.#classify = classify;
    this.#read = read;
    this.#run = run;
  }

  readonly cancel = (): void => {
    this.#epoch += 1;
    const current = this.#interrupt;
    this.#interrupt = null;
    current?.();
  };

  readonly update = ({
    enabled,
    request,
  }: {
    readonly enabled: boolean;
    readonly request: ProjectTargetRequest;
  }): void => {
    this.cancel();
    if (!enabled) {
      return;
    }
    const currentEpoch = this.#epoch;
    this.#apply(request, { projectId: request.projectId, status: 'loading' });
    this.#interrupt = this.#run(
      this.#read(request.projectId).pipe(
        Effect.match({
          onFailure: (failure) => ({ classification: this.#classify(failure) }),
          onSuccess: (project) => ({ state: projectTargetStateOf(project, request) }),
        }),
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            if (currentEpoch !== this.#epoch) {
              return;
            }
            if ('state' in outcome) {
              this.#apply(request, outcome.state);
            } else {
              this.#apply(request, { projectId: request.projectId, status: outcome.classification });
            }
          }),
        ),
      ),
    );
  };
}

const noTargetCleanup = () => {
  // Nothing is pending when no target read is active.
};

const useProjectTargetDestination = ({
  projectId,
  scope,
}: {
  readonly projectId: ProjectId;
  readonly scope: ProjectTargetScope;
}) => {
  const [applied, setApplied] = useState<{ readonly key: string; readonly state: ProjectTargetState } | null>(null);
  const [retry, setRetry] = useState(0);
  const controllerRef = useRef<ProjectTargetController<ProjectTargetFailure> | null>(null);
  useEffect(() => {
    if (controllerRef.current !== null) {
      return;
    }
    controllerRef.current = new ProjectTargetController<ProjectTargetFailure>(
      (request, state) => setApplied({ key: projectTargetRequestKey(request), state }),
      projectTargetFailureStatus,
      readProjectTarget,
      interruptProjectTargetRead,
    );
  }, []);
  const { principalId, tenantId } = scope;
  const legalEntityId = scope.kind === 'company' ? scope.legalEntityId : undefined;
  useEffect(() => {
    const controller = controllerRef.current;
    if (controller === null) {
      return noTargetCleanup;
    }
    controller.update({
      enabled: true,
      request: {
        attempt: retry,
        projectId,
        scope:
          legalEntityId === undefined
            ? { kind: 'tenant', principalId, tenantId }
            : { kind: 'company', legalEntityId, principalId, tenantId },
      },
    });
    return () => controller.cancel();
  }, [legalEntityId, principalId, projectId, retry, tenantId]);
  const requestKey = projectTargetRequestKey({ projectId, scope });
  const state: ProjectTargetState =
    applied !== null && applied.key === requestKey ? applied.state : { projectId, status: 'loading' };
  const retryRead = () => {
    setApplied(null);
    setRetry((current) => current + 1);
  };
  return { handleRetry: retryRead, state };
};

const projectCreatedAtFormatters = {
  cs: new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }),
  en: new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }),
} as const;

const projectCreatedAt = (createdAt: Project['createdAt'], language: string | undefined): string =>
  (language === 'cs' ? projectCreatedAtFormatters.cs : projectCreatedAtFormatters.en).format(
    DateTime.toDateUtc(createdAt),
  );

const OpenCreateButton = () => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  return (
    <Button
      onClick={() => {
        void navigate({ search: {}, to: `/${language ?? 'cs'}/projects/create-project` });
      }}
      type="button"
      variant="secondary"
    >
      {t(`${projectDetailKey}.openCreate`)}
    </Button>
  );
};

const ProjectTargetLoading = () => {
  const { t } = useModernI18n();
  return (
    <section
      aria-busy="true"
      aria-labelledby="project-target-heading"
      className="projects:mx-auto projects:w-full projects:max-w-5xl projects:px-4 projects:py-8 projects:sm:px-8 projects:lg:px-12"
    >
      <h1
        className="projects:text-3xl projects:font-bold projects:text-(--color-page-fg) projects:sm:text-4xl"
        id="project-target-heading"
      >
        {t(`${projectDetailKey}.title`)}
      </h1>
      <p className="projects:mt-4 projects:text-sm projects:text-(--color-fg-secondary)">
        {t(`${projectDetailKey}.loading`)}
      </p>
    </section>
  );
};

const ProjectTargetMessage = ({
  notice,
  onRetry,
  showOpenCreate = false,
}: {
  readonly notice: ProjectTargetNotice;
  readonly onRetry?: () => void;
  readonly showOpenCreate?: boolean;
}) => {
  const { t } = useModernI18n();
  return (
    <section
      aria-labelledby="project-target-heading"
      className="projects:mx-auto projects:w-full projects:max-w-5xl projects:px-4 projects:py-8 projects:sm:px-8 projects:lg:px-12"
    >
      <h1
        className="projects:text-3xl projects:font-bold projects:text-(--color-page-fg) projects:sm:text-4xl"
        id="project-target-heading"
      >
        {t(`${projectDetailKey}.title`)}
      </h1>
      <StatusText
        className="projects:mt-4"
        role={notice.tone === 'error' ? 'alert' : 'status'}
        showIcon
        status={notice.tone}
      >
        {t(notice.labelKey)}
      </StatusText>
      {(notice.retry && onRetry !== undefined) || showOpenCreate ? (
        <div className="projects:mt-6 projects:flex projects:flex-wrap projects:gap-3">
          {notice.retry && onRetry !== undefined && (
            <Button onClick={onRetry} type="button" variant="secondary">
              {t(`${projectDetailKey}.retry`)}
            </Button>
          )}
          {showOpenCreate && <OpenCreateButton />}
        </div>
      ) : null}
    </section>
  );
};

const ProjectFact = ({ children, label }: { readonly children: ReactNode; readonly label: string }) => (
  <div className="projects:flex projects:min-w-0 projects:flex-col projects:gap-1">
    <dt className="projects:text-xs projects:text-(--color-fg-secondary)">{label}</dt>
    <dd className="projects:break-words projects:text-sm">{children}</dd>
  </div>
);

const ProjectIdentifier = ({ value }: { readonly value: string }) => (
  <span className="projects:font-mono projects:text-xs projects:break-all">{value}</span>
);

const ProjectDetail = ({ project }: { readonly project: ProjectTargetRecord }) => {
  const { language, t } = useModernI18n();
  const archived = project.lifecycleState === 'archived';
  const shortText = Option.getOrNull(project.shortText);
  const parentProjectId = Option.getOrNull(project.parentProjectId);
  return (
    <section
      aria-labelledby="project-target-heading"
      className="projects:mx-auto projects:w-full projects:max-w-5xl projects:px-4 projects:py-8 projects:sm:px-8 projects:lg:px-12"
    >
      <div className="projects:flex projects:flex-wrap projects:items-start projects:justify-between projects:gap-4">
        <div className="projects:min-w-0">
          <h1
            className="projects:text-3xl projects:font-bold projects:text-(--color-page-fg) projects:sm:text-4xl"
            id="project-target-heading"
          >
            {project.name}
          </h1>
          <p className="projects:mt-2 projects:text-sm projects:text-(--color-fg-secondary)">
            {t(`${projectDetailKey}.fields.prefix`)}: {project.prefix}
          </p>
        </div>
        <Badge size="md" variant={archived ? 'warning' : 'success'}>
          {t(`${projectDetailKey}.lifecycle.${project.lifecycleState}`)}
        </Badge>
      </div>
      {archived && (
        <StatusText className="projects:mt-4" showIcon status="warning">
          {t(`${projectDetailKey}.archivedNotice`)}
        </StatusText>
      )}
      <dl className="projects:mt-6 projects:grid projects:gap-4 projects:sm:grid-cols-2">
        <ProjectFact label={t(`${projectDetailKey}.fields.shortText`)}>
          {shortText === null ? (
            t(`${projectDetailKey}.notProvided`)
          ) : (
            <p className="projects:whitespace-pre-line">{shortText}</p>
          )}
        </ProjectFact>
        {/* Field-projected reads omit governed principals; an omitted field is not shown, never guessed. */}
        {project.ownerPrincipalId !== undefined && (
          <ProjectFact label={t(`${projectDetailKey}.fields.owner`)}>
            <ProjectIdentifier value={project.ownerPrincipalId} />
          </ProjectFact>
        )}
        {project.createdByPrincipalId !== undefined && (
          <ProjectFact label={t(`${projectDetailKey}.fields.createdBy`)}>
            <ProjectIdentifier value={project.createdByPrincipalId} />
          </ProjectFact>
        )}
        <ProjectFact label={t(`${projectDetailKey}.fields.createdAt`)}>
          {projectCreatedAt(project.createdAt, language)}
        </ProjectFact>
        <ProjectFact label={t(`${projectDetailKey}.fields.parentProject`)}>
          {parentProjectId === null ? t(`${projectDetailKey}.noParent`) : <ProjectIdentifier value={parentProjectId} />}
        </ProjectFact>
        <ProjectFact label={t(`${projectDetailKey}.fields.projectId`)}>
          <ProjectIdentifier value={project.projectId} />
        </ProjectFact>
      </dl>
    </section>
  );
};

const ProjectTargetDetail = ({
  projectId,
  scope,
}: {
  readonly projectId: ProjectId;
  readonly scope: ProjectTargetScope;
}) => {
  const destination = useProjectTargetDestination({ projectId, scope });
  const { state } = destination;
  if (state.status === 'ready') {
    return <ProjectDetail project={state.project} />;
  }
  if (state.status === 'loading') {
    return <ProjectTargetLoading />;
  }
  const notice = projectTargetNotice(state);
  if (notice === undefined) {
    return <ProjectTargetLoading />;
  }
  return (
    <ProjectTargetMessage
      notice={notice}
      onRetry={destination.handleRetry}
      showOpenCreate={state.status === 'missing'}
    />
  );
};

const ProjectTargetHead = () => {
  const { t } = useModernI18n();
  return (
    <Helmet>
      <title>{t(`${projectDetailKey}.seoTitle`)}</title>
      <meta content={t(`${projectDetailKey}.seoDescription`)} name="description" />
      <meta content="noindex, nofollow" name="robots" />
    </Helmet>
  );
};

const ProjectTargetFrame = ({ children }: { readonly children: ReactNode }) => (
  <>
    <ProjectTargetHead />
    {children}
  </>
);

const ProjectTargetPage = ({
  scope,
  target,
}: {
  readonly scope: ProjectTargetScope | undefined;
  readonly target: ProjectSearchTarget;
}) => {
  if (target.kind !== 'id') {
    return (
      <ProjectTargetFrame>
        <ProjectTargetMessage notice={projectInvalidNotice} showOpenCreate />
      </ProjectTargetFrame>
    );
  }
  if (scope === undefined) {
    return (
      <ProjectTargetFrame>
        <ProjectTargetMessage notice={projectScopeNotice} />
      </ProjectTargetFrame>
    );
  }
  return (
    <ProjectTargetFrame>
      <ProjectTargetDetail projectId={target.projectId} scope={scope} />
    </ProjectTargetFrame>
  );
};

const CreateProjectPageContent = () => {
  const { t } = useModernI18n();
  const headingId = 'create-project-heading';
  return (
    <section
      aria-labelledby={headingId}
      className="projects:mx-auto projects:w-full projects:max-w-5xl projects:px-4 projects:py-8 projects:sm:px-8 projects:lg:px-12"
    >
      <h1
        className="projects:text-3xl projects:font-bold projects:text-(--color-page-fg) projects:sm:text-4xl"
        id={headingId}
      >
        {t('projects.pages.createProject.title')}
      </h1>
      <CreateProjectForm />
    </section>
  );
};

const CreateProjectPage = (props: Partial<ModulePageProps>) => {
  const location = useRouterState({ select: (routerState) => routerState.location.searchStr });
  const searchStr = location === '' ? (props.search ?? '') : location;
  const target = projectSearchTargetFromSearchStr(searchStr);
  const actorScopeKey =
    props.context === undefined
      ? pageDataTenantScopeKey(props.tenantContext, 'projects.core')
      : pageDataScopeKey(props.context, 'projects.core');
  const scope = projectTargetScopeOf(props);
  const actorScope = actorScopeKey ?? 'standalone:projects.core';
  const contentKey = target.kind === 'id' ? `${actorScope}:${target.projectId}` : actorScope;
  const mode = projectPageMode(target);

  return (
    <FederatedI18nBoundary
      defaultNamespace="projects"
      fallbackLanguage="en"
      resources={projectsI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      {mode === 'create' ? (
        <>
          <UltramodernRouteHead />
          <CreateProjectPageContent key={contentKey} />
        </>
      ) : (
        <ProjectTargetPage key={contentKey} scope={scope} target={target} />
      )}
    </FederatedI18nBoundary>
  );
};

export default CreateProjectPage;
