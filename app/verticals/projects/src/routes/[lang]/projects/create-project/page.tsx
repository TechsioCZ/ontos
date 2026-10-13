import {
  CreateProjectActionAlreadyCommittedProblemSchema,
  CreateProjectActionCommitIndeterminateProblemSchema,
} from '../../../../../shared/apis/create-project-action.ts';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { RadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime';
import { Effect, Option, Random, Schema } from 'effect';
import { useRef, useState } from 'react';
import { CreateProjectPayloadSchema } from '../../../../../shared/actions/create-project.ts';
import { ProjectPrefixInputSchema } from '../../../../../shared/domain/project.ts';
import { executeCreateProject } from '../../../../api/create-project-action-client.ts';
import { executeProjectOwnerCandidates } from '../../../../api/project-owner-candidates-client.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { projectsI18nResources } from '../../../../i18n/resources';
import '../../../ui-kit.css';
import '../../../index.css';

interface OwnerCandidate {
  displayName: string;
  principalId: string;
}
const loadOwners = Effect.fn('ProjectsPage.loadOwners')(function* loadOwners({
  prefix,
  query,
  setCandidates,
  setStatus,
}: {
  prefix: string;
  query: string;
  setCandidates: (value: readonly OwnerCandidate[]) => void;
  setStatus: (value: string) => void;
}) {
  const correlationId = `projects:${yield* Random.nextInt}:${yield* Random.nextInt}`;
  const result = yield* executeProjectOwnerCandidates({ prefix, query }, correlationId).pipe(
    Effect.match({
      onFailure: (error) => ({
        candidates: [],
        status: 'status' in error && error.status === 403 ? 'forbidden' : 'unavailable',
      }),
      onSuccess: (response) => ({
        candidates: response.candidates,
        status: response.candidates.length === 0 ? 'empty' : 'idle',
      }),
    }),
  );
  setCandidates(result.candidates);
  setStatus(result.status);
});
const createFromForm = Effect.fn('ProjectsPage.createFromForm')(function* createFromForm({
  payload,
  requestKey,
  setStatus,
}: {
  payload: typeof CreateProjectPayloadSchema.Type;
  requestKey: { current: string | null };
  setStatus: (value: string) => void;
}) {
  const idempotencyKey = requestKey.current ?? `projects:${yield* Random.nextInt}:${yield* Random.nextInt}`;
  requestKey.current = idempotencyKey;
  const correlationId = `projects:${yield* Random.nextInt}:${yield* Random.nextInt}`;
  const outcome = yield* executeCreateProject(payload, correlationId, { idempotencyKey }).pipe(
    Effect.match({
      onFailure: (error) => {
        if (Schema.is(CreateProjectActionAlreadyCommittedProblemSchema)(error)) {
          return 'success';
        }
        if (Schema.is(CreateProjectActionCommitIndeterminateProblemSchema)(error)) {
          return 'uncertain';
        }
        if ('status' in error) {
          if (error.status === 403 || error.status === 401) {
            return 'forbidden';
          }
          if (error.status === 409) {
            return 'conflict';
          }
          if (error.status === 400 || error.status === 422) {
            return 'invalid';
          }
        }
        return 'unavailable';
      },
      onSuccess: () => 'success',
    }),
  );
  setStatus(outcome);
});

const CreateProjectPageContent = () => {
  const { t } = useModernI18n();
  const headingId = 'create-project-heading';
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [shortText, setShortText] = useState('');
  const [query, setQuery] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [candidates, setCandidates] = useState<readonly { displayName: string; principalId: string }[]>([]);
  const [status, setStatus] = useState('idle');
  const requestKey = useRef<string | null>(null);
  const busy = status === 'loading' || status === 'saving' || status === 'uncertain';
  const payload = {
    name,
    ownerPrincipalId: ownerId,
    prefix,
    shortText: shortText === '' ? Option.none<string>() : Option.some(shortText),
  };
  const valid =
    Schema.is(CreateProjectPayloadSchema)(payload) && candidates.some((candidate) => candidate.principalId === ownerId);
  const resetSelection = () => {
    setOwnerId('');
    setCandidates([]);
    setStatus('idle');
    requestKey.current = null;
  };
  const findOwners = () => {
    resetSelection();
    setStatus('loading');
    void browserRuntime.runPromise(loadOwners({ prefix, query, setCandidates, setStatus }));
  };
  const create = () => {
    if (!valid) {
      setStatus('invalid');
      return;
    }
    setStatus('saving');
    void browserRuntime.runPromise(createFromForm({ payload, requestKey, setStatus }));
  };

  return (
    <>
      <UltramodernRouteHead />
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
        <form
          className="projects:mt-6 projects:grid projects:gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <FormInput
            disabled={busy}
            id="project-name"
            label={t('projects.pages.createProject.name')}
            onChange={(event) => {
              setName(event.target.value);
              requestKey.current = null;
            }}
            required
            value={name}
          />
          <FormInput
            disabled={busy}
            helpText={t('projects.pages.createProject.prefixHelp')}
            id="project-prefix"
            label={t('projects.pages.createProject.prefixLabel')}
            onChange={(event) => {
              setPrefix(event.target.value);
              resetSelection();
            }}
            required
            value={prefix}
          />
          <FormTextarea
            disabled={busy}
            id="project-short-text"
            label={t('projects.pages.createProject.shortText')}
            onChange={(event) => {
              setShortText(event.target.value);
              requestKey.current = null;
            }}
            value={shortText}
          />
          <FormInput
            disabled={busy}
            id="project-owner-query"
            label={t('projects.pages.createProject.ownerQuery')}
            onChange={(event) => {
              setQuery(event.target.value);
              resetSelection();
            }}
            value={query}
          />
          <Button
            disabled={busy || !Schema.is(ProjectPrefixInputSchema)(prefix)}
            isLoading={status === 'loading'}
            onClick={() => {
              findOwners();
            }}
            type="button"
            variant="secondary"
          >
            {t('projects.pages.createProject.findOwners')}
          </Button>
          <RadioGroup
            disabled={busy}
            name="project-owner"
            onValueChange={(value) => {
              setOwnerId(value ?? '');
              requestKey.current = null;
            }}
            required
            value={ownerId}
          >
            <RadioGroup.Label>{t('projects.pages.createProject.owner')}</RadioGroup.Label>
            <RadioGroup.ItemGroup>
              {candidates.map((candidate) => (
                <RadioGroup.Item key={candidate.principalId} value={candidate.principalId}>
                  <RadioGroup.ItemHiddenInput />
                  <RadioGroup.ItemControl />
                  <RadioGroup.ItemContent>
                    <RadioGroup.ItemText>{candidate.displayName}</RadioGroup.ItemText>
                  </RadioGroup.ItemContent>
                </RadioGroup.Item>
              ))}
            </RadioGroup.ItemGroup>
          </RadioGroup>
          <p aria-live="polite">{t(`projects.pages.createProject.${status}`)}</p>
          <Button disabled={busy || !valid || status === 'success'} isLoading={status === 'saving'} type="submit">
            {t('projects.pages.createProject.submit')}
          </Button>
        </form>
      </section>
    </>
  );
};

const CreateProjectPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="projects"
    fallbackLanguage="en"
    resources={projectsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CreateProjectPageContent />
  </FederatedI18nBoundary>
);

export default CreateProjectPage;
