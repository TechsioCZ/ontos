import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@app/admin-ui/form-controls';
import { Select } from '@techsio/ui-kit/molecules/select';
import { DateTime, Option, Schema } from 'effect';
import { useState } from 'react';

import { emptyWhySearch, hiddenWhySubjects, WhySearchDraftSchema } from './why-view-model.ts';
import type { WhyResultView, WhySearchDraft, WhySubjectOptions } from './why-view-model.ts';
import { WhySubjectPicker } from './why-subject-picker.tsx';

const modeLabelKey = 'shell.accessAdmin.mode.label';
const inputFields = [
  ['capabilityKey', 'capabilityKey', 200],
  ['companyId', 'companyId', 36],
  ['targetModule', 'targetModule', 200],
  ['recordKey', 'record', 500],
  ['currency', 'currency', 3],
  ['minor', 'amountMinor', 16],
] as const;
const WhyFormSchema = Schema.fromFormData(WhySearchDraftSchema);

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
      <section aria-label={t('shell.accessAdmin.outcome.label')} className="shell:grid shell:gap-4">
        <Badge
          aria-label={t('shell.accessAdmin.accessible.outcomeBadge', {
            outcome: t(`shell.accessAdmin.outcome.${decision.outcome}`),
          })}
          variant={outcomeVariants[decision.outcome]}
        >
          {t(`shell.accessAdmin.outcome.${decision.outcome}`)}
        </Badge>
        <p>
          {decision.subjectName === null
            ? t('shell.accessAdmin.why.currentPersonChoice')
            : t('shell.accessAdmin.why.checkingPerson', { name: decision.subjectName })}
        </p>
        <dl className="shell:grid shell:gap-2 shell:break-words">
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
        <ul aria-label={t('shell.accessAdmin.accessible.reasonList')} className="shell:grid shell:gap-2">
          {decision.reasonKeys.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
        {decision.authorityMetadata === 'included' ? (
          <>
            {decision.authority.length > 0 ? (
              <section aria-label={t('shell.accessAdmin.why.authority')} className="shell:grid shell:gap-2">
                <h3 className="shell:text-title-sm">{t('shell.accessAdmin.why.authority')}</h3>
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
              <section aria-label={t('shell.accessAdmin.why.grantableBy')} className="shell:grid shell:gap-2">
                <h3 className="shell:text-title-sm">{t('shell.accessAdmin.why.grantableBy')}</h3>
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
          <Button onClick={onRetry} variant="secondary">
            {t('shell.accessAdmin.common.retry')}
          </Button>
        ) : null}
        <p>{t('shell.accessAdmin.why.checkOnly')}</p>
      </section>
    );
  }
  return (
    <div className="shell:grid shell:gap-3">
      {result.state === 'unavailable' ? (
        <Badge variant="outline">{t('shell.accessAdmin.outcome.unavailable')}</Badge>
      ) : null}
      <StatusText showIcon status={result.state === 'idle' ? 'default' : 'error'}>
        {t(stateKeys[result.state])}
      </StatusText>
      {result.state === 'unavailable' || result.state === 'conflict' ? (
        <Button onClick={onRetry} variant="secondary">
          {t('shell.accessAdmin.common.retry')}
        </Button>
      ) : null}
    </div>
  );
};

export const WhyView = ({
  draft: initialDraft,
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
  const [draft, setDraft] = useState(() => initialDraft);
  const modes = (['run', 'propose'] as const).map((value) => ({ label: t(`shell.accessAdmin.mode.${value}`), value }));
  return (
    <section
      aria-label={t('shell.accessAdmin.why.title')}
      className="shell:grid shell:w-full shell:max-w-5xl shell:gap-6"
    >
      <p>{t('shell.accessAdmin.why.description')}</p>
      <p>{t('shell.accessAdmin.why.currentPerson')}</p>
      <form
        action={(data) => {
          data.set('mode', draft.mode);
          data.set('subject', draft.subject);
          onCheck(Option.getOrElse(Schema.decodeOption(WhyFormSchema)(data), () => emptyWhySearch));
        }}
        aria-busy={pending}
        className="shell:grid shell:gap-4"
      >
        <fieldset className="shell:grid shell:gap-4 shell:md:grid-cols-2" disabled={pending}>
          <legend className="shell:sr-only">{t('shell.accessAdmin.common.search')}</legend>
          <WhySubjectPicker
            onChange={(subject) => setDraft((previous) => ({ ...previous, subject }))}
            onMore={onMorePeople}
            options={subjects}
            pending={pending}
            value={draft.subject}
          />
          {inputFields.map(([name, label, maxLength]) => (
            <FormInput
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              id={`why-${name}`}
              inputMode={name === 'minor' ? 'numeric' : 'text'}
              key={name}
              label={t(`shell.accessAdmin.why.${label}`)}
              maxLength={maxLength}
              name={name}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setDraft((previous) => ({ ...previous, [name]: value }));
              }}
              required={name === 'capabilityKey'}
              spellCheck={false}
              type="text"
              value={draft[name]}
            />
          ))}
          <Select
            disabled={pending}
            items={modes}
            name="mode"
            onValueChange={({ value }) => {
              const [selected] = value;
              if (selected === 'run' || selected === 'propose') {
                setDraft((previous) => ({ ...previous, mode: selected }));
              }
            }}
            value={[draft.mode]}
          >
            <Select.Label>{t(modeLabelKey)}</Select.Label>
            <Select.Control>
              <Select.Trigger aria-label={t(modeLabelKey)}>
                <Select.ValueText />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {modes.map((item) => (
                  <Select.Item item={item} key={item.value}>
                    <Select.ItemText />
                    <Select.ItemIndicator />
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select>
        </fieldset>
        <Button
          disabled={pending}
          isLoading={pending}
          loadingText={t('shell.accessAdmin.common.loading')}
          type="submit"
          variant="primary"
        >
          {t('shell.accessAdmin.why.submit')}
        </Button>
      </form>
      <div aria-busy={pending} aria-live="polite">
        {pending ? (
          <StatusText status="default">{t('shell.accessAdmin.common.loading')}</StatusText>
        ) : (
          <WhyResult onRetry={onRetry} result={result} />
        )}
      </div>
      <div className="shell:grid shell:gap-2">
        <Button aria-describedby="why-request-unavailable" disabled type="button" variant="secondary">
          {t('shell.accessAdmin.why.requestAccess')}
        </Button>
        <p id="why-request-unavailable">{t('shell.accessAdmin.why.requestAccessUnavailable')}</p>
      </div>
    </section>
  );
};
