import {
  ChoiceField,
  FormReact,
  FormRoot,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime, Effect, Option, Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useEffect } from 'react';

import { browserAtomRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { hiddenWhySubjects, WhySearchDraftSchema } from './why-view-model.ts';
import type { WhyResultView, WhySearchDraft, WhySubjectOptions } from './why-view-model.ts';

const modeLabelKey = 'shell.accessAdmin.mode.label';
const retryKey = 'shell.accessAdmin.common.retry';
const currentPersonKey = 'shell.accessAdmin.why.currentPersonChoice';
const inputFields = [
  ['capabilityKey', 'capabilityKey', 200],
  ['companyId', 'companyId', 36],
  ['targetModule', 'targetModule', 200],
  ['recordKey', 'record', 500],
  ['currency', 'currency', 3],
  ['minor', 'amountMinor', 16],
] as const;

/** The people the picker offers now; another page or a new directory revision can drop the picked one. */
const offeredSubjects = Atom.make<WhySubjectOptions>(hiddenWhySubjects).pipe(Atom.keepAlive);

/** The picked person is no longer among the offered people: the person picks again. */
class WithdrawnSubject extends Schema.TaggedError<WithdrawnSubject>()('WithdrawnSubject', {}) {}

/**
 * The Why question as the person enters it: every field is trimmed by the draft Schema, and a
 * submitted draft is the trimmed one the route validates before it asks the BFF. A check needs a
 * capability key and, for another person, one the picker still offers.
 */
const whySearchForm = FormReact.make(
  fromPayload(WhySearchDraftSchema).refine(
    ({ capabilityKey }) =>
      capabilityKey.length > 0 || { issue: 'shell.accessAdmin.why.capabilityKeyRequired', path: ['capabilityKey'] },
  ),
  {
    fields: {
      capabilityKey: TextField,
      companyId: TextField,
      currency: TextField,
      minor: TextField,
      mode: ChoiceField,
      recordKey: TextField,
      subject: ChoiceField,
      targetModule: TextField,
    },
    onSubmit: (_submit, { decoded, get }) => {
      const subjects = get(offeredSubjects);
      // Another person is checked only while the picker offers them; an unavailable picker offers no one.
      return decoded.subject === '' ||
        (subjects.state === 'ready' && subjects.people.some((person) => person.value === decoded.subject))
        ? Effect.succeed(decoded)
        : Effect.fail(new WithdrawnSubject());
    },
    runtime: browserAtomRuntime,
    submitErrors: () => [{ message: 'shell.accessAdmin.why.subjectWithdrawn', path: 'subject' }],
  },
);

const outcomeVariants = { allowed: 'success', denied: 'danger', needsApproval: 'warning' } as const;
const stateKeys = {
  conflict: 'shell.accessAdmin.common.conflict',
  forbidden: 'shell.accessAdmin.common.forbidden',
  idle: 'shell.accessAdmin.why.empty',
  invalid: 'shell.accessAdmin.why.invalidInput',
  unauthenticated: 'shell.accessAdmin.common.unauthenticated',
  unavailable: 'shell.accessAdmin.why.unavailableNotDenial',
} as const;

export const WhyResult = ({ onRetry, result }: { readonly onRetry: () => void; readonly result: WhyResultView }) => {
  const { language, t } = useModernI18n();
  const formatDeadline = (date: string) =>
    DateTime.make(date).pipe(
      Option.map(DateTime.format({ dateStyle: 'medium', locale: language, timeStyle: 'long', timeZone: 'UTC' })),
      Option.getOrElse(() => t('shell.accessAdmin.common.unknown')),
    );
  if (result.state === 'decision') {
    const { decision, query } = result;
    return (
      <section aria-label={t('shell.accessAdmin.outcome.label')} className="grid gap-200">
        <Badge
          aria-label={t('shell.accessAdmin.accessible.outcomeBadge', {
            outcome: t(`shell.accessAdmin.outcome.${decision.outcome}`),
          })}
          severity={outcomeVariants[decision.outcome]}
        >
          {t(`shell.accessAdmin.outcome.${decision.outcome}`)}
        </Badge>
        <p>
          {decision.subjectName === null
            ? t(currentPersonKey)
            : t('shell.accessAdmin.why.checkingPerson', { name: decision.subjectName })}
        </p>
        <dl className="grid gap-150 break-words">
          <div>
            <dt>{t('shell.accessAdmin.why.capabilityKey')}</dt>
            <dd>{query.capabilityKey}</dd>
          </div>
          <div>
            <dt>{t(modeLabelKey)}</dt>
            <dd>{t(`shell.accessAdmin.mode.${query.mode}`)}</dd>
          </div>
          <div>
            <dt>{t('shell.accessAdmin.why.scope')}</dt>
            <dd>{query.companyId || t('shell.accessAdmin.common.tenantContext')}</dd>
          </div>
          {query.recordKey === '' ? null : (
            <div>
              <dt>{t('shell.accessAdmin.why.record')}</dt>
              <dd>
                {query.targetModule}: {query.recordKey}
              </dd>
            </div>
          )}
          {query.minor === '' ? null : (
            <div>
              <dt>{t('shell.accessAdmin.why.amountMinor')}</dt>
              <dd>
                {query.minor} {query.currency}
              </dd>
            </div>
          )}
          {decision.fieldClass === null ? null : (
            <div>
              <dt>{t('shell.accessAdmin.why.fieldClass')}</dt>
              <dd>{decision.fieldClass}</dd>
            </div>
          )}
          {decision.deadline === null ? null : (
            <div>
              <dt>{t('shell.accessAdmin.deadline.label')}</dt>
              <dd>{t('shell.accessAdmin.deadline.expiresAt', { date: formatDeadline(decision.deadline) })}</dd>
            </div>
          )}
        </dl>
        {query.minor === '' ? null : <p>{t('shell.accessAdmin.why.amountCaveat')}</p>}
        <ul aria-label={t('shell.accessAdmin.accessible.reasonList')} className="grid gap-150">
          {decision.reasonKeys.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
        {decision.authorityMetadata === 'included' ? (
          <>
            {decision.authority.length > 0 ? (
              <section aria-label={t('shell.accessAdmin.why.authority')} className="grid gap-150">
                <h3 className="text-lg">{t('shell.accessAdmin.why.authority')}</h3>
                <ul>
                  {decision.authority.map((role) => (
                    <li key={role.id}>
                      {role.name}
                      {role.deadline === null ? null : (
                        <p>{t('shell.accessAdmin.deadline.expiresAt', { date: formatDeadline(role.deadline) })}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {decision.grantableBy.length > 0 ? (
              <section aria-label={t('shell.accessAdmin.why.grantableBy')} className="grid gap-150">
                <h3 className="text-lg">{t('shell.accessAdmin.why.grantableBy')}</h3>
                <ul>
                  {decision.grantableBy.map((person) => (
                    <li key={person.id}>{person.name}</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <StatusText status="default">
            {t(
              decision.authorityMetadata === 'withheld'
                ? 'shell.accessAdmin.why.authorityWithheld'
                : 'shell.accessAdmin.why.authorityUnavailable',
            )}
          </StatusText>
        )}
        {decision.authorityMetadata === 'unavailable' ? (
          <Button onClick={onRetry} severity="secondary">
            {t(retryKey)}
          </Button>
        ) : null}
        <p>{t('shell.accessAdmin.why.checkOnly')}</p>
      </section>
    );
  }
  return (
    <div className="grid gap-150">
      {result.state === 'unavailable' ? (
        <Badge appearance="outline" severity="neutral">
          {t('shell.accessAdmin.outcome.unavailable')}
        </Badge>
      ) : null}
      <StatusText showIcon status={result.state === 'idle' ? 'default' : 'error'}>
        {t(stateKeys[result.state])}
      </StatusText>
      {result.state === 'unavailable' || result.state === 'conflict' ? (
        <Button onClick={onRetry} severity="secondary">
          {t(retryKey)}
        </Button>
      ) : null}
    </div>
  );
};

const subjectField = whySearchForm.getFieldAtoms(whySearchForm.fields.subject);

export const WhySubjectPicker = ({
  onMore,
  options,
  pending,
}: {
  readonly onMore?: (() => void) | undefined;
  readonly options: WhySubjectOptions;
  readonly pending: boolean;
}) => {
  const { t } = useModernI18n();
  const subject = useAtomValue(subjectField.value);
  const setSubject = useAtomSet(subjectField.setValue);
  if (options.state === 'hidden') {
    return null;
  }
  if (options.state === 'unavailable') {
    const otherPerson = Option.exists(subject, (value) => value !== '');
    return (
      <div className="grid gap-150">
        <StatusText aria-live="polite" status="default">
          {t('shell.accessAdmin.why.subjectPickerUnavailable')}
        </StatusText>
        {otherPerson ? (
          <>
            <StatusText aria-live="polite" status="error">
              {t('shell.accessAdmin.why.subjectWithdrawn')}
            </StatusText>
            <Button disabled={pending} onClick={() => setSubject('')} severity="secondary" type="button">
              {t(currentPersonKey)}
            </Button>
          </>
        ) : null}
        <Button disabled={pending || onMore === undefined} onClick={onMore} severity="secondary" type="button">
          {t(retryKey)}
        </Button>
      </div>
    );
  }
  const currentPerson = t(currentPersonKey);
  return (
    <div className="grid gap-150">
      <whySearchForm.subject
        disabled={pending}
        items={[{ label: currentPerson, value: '' }, ...options.people]}
        label={t('shell.accessAdmin.why.subjectPickerLabel')}
        placeholder={currentPerson}
      />
      {options.nextCursor === null ? null : (
        <Button disabled={pending || onMore === undefined} onClick={onMore} severity="secondary" type="button">
          {t('shell.accessAdmin.why.morePeople')}
        </Button>
      )}
    </div>
  );
};

export const AgentsUnavailable = () => {
  const { t } = useModernI18n();
  return (
    <section aria-label={t('shell.accessAdmin.agents.title')} className="grid gap-150">
      <h2 className="text-2xl">{t('shell.accessAdmin.agents.title')}</h2>
      <Badge appearance="outline" severity="neutral">
        {t('shell.accessAdmin.common.notAvailable')}
      </Badge>
      <StatusText showIcon status="default">
        {t('shell.accessAdmin.agents.unavailable')}
      </StatusText>
      <p>{t('shell.accessAdmin.agents.executionUnavailable')}</p>
      <p>{t('shell.accessAdmin.agents.readOnly')}</p>
    </section>
  );
};

export const WhyView = ({
  draft,
  onCheck,
  onMorePeople,
  onRetry,
  pending,
  result,
  subjects = hiddenWhySubjects,
}: {
  readonly draft: WhySearchDraft;
  readonly onCheck: (draft: WhySearchDraft) => void;
  readonly onMorePeople?: () => void;
  readonly onRetry: () => void;
  readonly pending: boolean;
  readonly result: WhyResultView;
  readonly subjects?: WhySubjectOptions;
}) => {
  const { t } = useModernI18n();
  const offer = useAtomSet(offeredSubjects);
  useEffect(() => offer(subjects), [offer, subjects]);
  const modes = (['run', 'propose'] as const).map((value) => ({ label: t(`shell.accessAdmin.mode.${value}`), value }));
  useAtomSubscribe(whySearchForm.submit, (submitted) => {
    if (AsyncResult.isSuccess(submitted) && !submitted.waiting) {
      onCheck(submitted.value);
    }
  });
  return (
    <section aria-label={t('shell.accessAdmin.why.title')} className="grid w-full max-w-5xl gap-300">
      <p>{t('shell.accessAdmin.why.description')}</p>
      <p>{t('shell.accessAdmin.why.currentPerson')}</p>
      <FormRoot
        className="grid gap-200"
        defaultValues={draft}
        form={whySearchForm}
        translateMessage={(message) => t(message, { defaultValue: t('shell.accessAdmin.why.invalidInput') })}
      >
        <fieldset className="grid gap-200 md:grid-cols-2" disabled={pending}>
          <legend className="sr-only">{t('shell.accessAdmin.common.search')}</legend>
          <WhySubjectPicker onMore={onMorePeople} options={subjects} pending={pending} />
          {inputFields.map(([name, label, maxLength]) => {
            const Input = whySearchForm[name];
            return (
              <Input
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                disabled={pending}
                id={`why-${name}`}
                inputMode={name === 'minor' ? 'numeric' : 'text'}
                key={name}
                label={t(`shell.accessAdmin.why.${label}`)}
                maxLength={maxLength}
                required={name === 'capabilityKey'}
                spellCheck={false}
                type="text"
              />
            );
          })}
          <whySearchForm.mode disabled={pending} items={modes} label={t(modeLabelKey)} />
        </fieldset>
        <Button
          disabled={pending}
          isLoading={pending}
          loadingText={t('shell.accessAdmin.common.loading')}
          severity="primary"
          type="submit"
        >
          {t('shell.accessAdmin.why.submit')}
        </Button>
      </FormRoot>
      <div aria-busy={pending} aria-live="polite">
        {pending ? (
          <StatusText status="default">{t('shell.accessAdmin.common.loading')}</StatusText>
        ) : (
          <WhyResult onRetry={onRetry} result={result} />
        )}
      </div>
      <div className="grid gap-150">
        <Button aria-describedby="why-request-unavailable" disabled severity="secondary" type="button">
          {t('shell.accessAdmin.why.requestAccess')}
        </Button>
        <p id="why-request-unavailable">{t('shell.accessAdmin.why.requestAccessUnavailable')}</p>
      </div>
      <AgentsUnavailable />
    </section>
  );
};
