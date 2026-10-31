import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DetailList, SidePanel } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Option } from 'effect';
import type { useCustomerIdentityReview } from './customers-data.ts';

type ReviewModel = ReturnType<typeof useCustomerIdentityReview>;
type ReviewDetail = Extract<ReviewModel['detail'], { readonly status: 'ready' }>['value'];
const reviewKey = 'party-registry.pages.customers.identityReview';

const ReviewParty = ({
  party,
  review,
}: {
  readonly party: ReviewDetail['parties'][number];
  readonly review: ReviewModel;
}) => {
  const { t } = useModernI18n();
  const { contacts, identity, partyRef } = party;
  return (
    <div className="flex flex-col gap-150" key={partyRef.resourceId}>
      <Button
        aria-pressed={review.selectedPartyId === partyRef.resourceId}
        disabled={
          !review.canResolve ||
          identity.status !== 'ready' ||
          identity.value.resolution.kind !== 'DIRECT' ||
          Option.isSome(identity.value.party.archivedAt)
        }
        onClick={() => review.setSelectedPartyId(partyRef.resourceId)}
        size="sm"
        theme="outlined"
        variant="secondary"
      >
        {t(`${reviewKey}.selectParty`, {
          name:
            identity.status === 'ready'
              ? Option.getOrElse(identity.value.party.displayName, () => partyRef.resourceId)
              : partyRef.resourceId,
        })}
      </Button>
      <p className="break-words text-sm">{partyRef.resourceId}</p>
      {identity.status === 'ready' ? (
        <>
          <p className="text-sm">{t(`${reviewKey}.types.${identity.value.party.partyType}`)}</p>
          {(identity.value.resolution.kind !== 'DIRECT' || Option.isSome(identity.value.party.archivedAt)) && (
            <p className="text-sm">{t(`${reviewKey}.unselectable`)}</p>
          )}
        </>
      ) : (
        <StatusText status="error">{t(`${reviewKey}.${identity.status}`)}</StatusText>
      )}
      {contacts.status === 'ready' ? (
        contacts.value.items.map((contact) =>
          !contact.current || contact.value.type === 'ADDRESS' ? null : (
            <p className="text-sm" key={contact.contactPointRef.resourceId}>
              {contact.value.displayValue}
            </p>
          ),
        )
      ) : (
        <StatusText status="error">{t(`${reviewKey}.${contacts.status}`)}</StatusText>
      )}
    </div>
  );
};

const ReviewCaseDetail = ({
  duplicate,
  review,
}: {
  readonly duplicate: ReviewDetail;
  readonly review: ReviewModel;
}) => {
  const { t } = useModernI18n();
  return (
    <>
      <DetailList
        items={[
          { label: t(`${reviewKey}.caseId`), value: duplicate.candidateCase.caseRef.resourceId },
          {
            label: t(`${reviewKey}.candidateName`),
            value: duplicate.candidateCase.candidate.displayName ?? t(`${reviewKey}.unnamed`),
          },
          {
            label: t(`${reviewKey}.partyType`),
            value: t(`${reviewKey}.types.${duplicate.candidateCase.candidate.partyType}`),
          },
          {
            label: t(`${reviewKey}.state`),
            value: t(`${reviewKey}.states.${duplicate.candidateCase.lifecycleState}`),
          },
          { label: t(`${reviewKey}.source`), value: duplicate.candidateCase.candidate.provenance.source },
          { label: t(`${reviewKey}.rule`), value: duplicate.candidateCase.matchRuleVersion },
          {
            label: t(`${reviewKey}.resolution`),
            value:
              duplicate.candidateCase.resolutionOutcome === null
                ? '—'
                : t(`${reviewKey}.outcomes.${duplicate.candidateCase.resolutionOutcome}`),
          },
          { label: t(`${reviewKey}.reason`), value: duplicate.candidateCase.resolutionReason ?? '—' },
        ]}
      />
      {duplicate.candidateCase.candidate.officialIdentifiers.map((identifier) => (
        <p className="text-sm" key={`${identifier.identifierType}:${identifier.value}`}>
          {t(`${reviewKey}.identifier`, { type: identifier.identifierType, value: identifier.value })}
        </p>
      ))}
      <h3 className="font-medium">{t(`${reviewKey}.evidence`)}</h3>
      {duplicate.candidateCase.candidate.evidenceRefs.map((reference) => (
        <p className="break-words text-sm" key={reference}>
          {reference}
        </p>
      ))}
      {(duplicate.candidateCase.candidate.subjectEvidence ?? []).map((evidence) => (
        <p className="break-words text-sm" key={evidence.evidenceRef}>
          {evidence.statement}
        </p>
      ))}
      {duplicate.candidateCase.evaluatedEvidence.map((evidence) => (
        <p
          className="break-words text-sm"
          key={`${evidence.ruleKey}:${evidence.identifierType ?? ''}:${evidence.namespace ?? ''}:${evidence.normalizedValue ?? ''}:${evidence.officialIdentifierRef?.resourceId ?? ''}:${evidence.reason}`}
        >
          {evidence.reason}
        </p>
      ))}
      <h3 className="font-medium">{t(`${reviewKey}.candidates`)}</h3>
      {duplicate.parties.length === 0 && <p className="text-sm">{t(`${reviewKey}.noCandidates`)}</p>}
      {duplicate.parties.map((party) => (
        <ReviewParty key={party.partyRef.resourceId} party={party} review={review} />
      ))}
      <FormInput
        disabled={!review.canResolve}
        id="customer-duplicate-reason"
        label={t(`${reviewKey}.reason`)}
        maxLength={1000}
        onChange={(event) => review.setReason(event.target.value)}
        required
        value={review.reason}
      />
      <p className="text-fg-secondary text-sm">{t(`${reviewKey}.createWarning`)}</p>
      <div className="flex flex-wrap gap-150">
        <Button
          disabled={!review.canResolve || review.selectedPartyId === '' || review.reason.trim() === ''}
          onClick={() => review.resolve('MATCH_EXISTING')}
          size="sm"
          variant="primary"
        >
          {t(`${reviewKey}.match`)}
        </Button>
        <Button
          disabled={!review.canResolve || review.reason.trim() === ''}
          onClick={() => review.resolve('CREATE_NEW')}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {t(`${reviewKey}.createNew`)}
        </Button>
        <Button
          disabled={!review.canResolve || review.reason.trim() === ''}
          onClick={() => review.resolve('NEEDS_EVIDENCE')}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {t(`${reviewKey}.needsEvidence`)}
        </Button>
        <Button
          disabled={!review.canResolve || review.reason.trim() === ''}
          onClick={() => review.resolve('DISMISSED_AS_NON_SUBJECT')}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {t(`${reviewKey}.dismiss`)}
        </Button>
      </div>
    </>
  );
};

export const CustomerIdentityReviewPanel = ({ review }: { readonly review: ReviewModel }) => {
  const { t } = useModernI18n();
  const duplicate = review.detail.status === 'ready' ? review.detail.value : undefined;
  return (
    <SidePanel
      actions={
        <Button disabled={review.busy} onClick={() => review.closeReview(false)} theme="outlined" variant="secondary">
          {t(`${reviewKey}.close`)}
        </Button>
      }
      closeOnInteractOutside={false}
      onOpenChange={(next) => review.closeReview(next)}
      open={review.open}
      resizeLabel={t('party-registry.sidePanel.resize')}
      size="xl"
      title={t(`${reviewKey}.title`)}
    >
      <div aria-busy={review.busy || review.loading} className="flex flex-col gap-250 py-200">
        <p className="text-fg-secondary text-sm">{t(`${reviewKey}.description`)}</p>
        {review.notice !== undefined && (
          <StatusText aria-live="polite" status={review.notice.success ? 'success' : 'error'}>
            {t(`${reviewKey}.${review.notice.key}`)}
          </StatusText>
        )}
        <div className="flex flex-wrap gap-150">
          <Button
            disabled={review.busy || review.uncertain}
            onClick={() => review.loadQueue()}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${reviewKey}.reloadQueue`)}
          </Button>
          {review.queue.status === 'ready' && review.queue.value.nextCaseRef !== null && (
            <Button
              disabled={review.busy || review.uncertain}
              onClick={() => {
                if (review.queue.status === 'ready' && review.queue.value.nextCaseRef !== null) {
                  review.loadQueue(review.queue.value.nextCaseRef);
                }
              }}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {t(`${reviewKey}.next`)}
            </Button>
          )}
        </div>
        {review.queue.status === 'loading' && <StatusText aria-live="polite">{t(`${reviewKey}.loading`)}</StatusText>}
        {review.queue.status === 'failed' && (
          <StatusText status="error">{t(`${reviewKey}.${review.queue.failure}`)}</StatusText>
        )}
        {review.queue.status === 'ready' && (
          <>
            {review.queue.value.items.length === 0 && <p>{t(`${reviewKey}.empty`)}</p>}
            {review.queue.value.items.map((item) => (
              <Button
                aria-pressed={duplicate?.candidateCase.caseRef.resourceId === item.caseRef.resourceId}
                disabled={review.busy || review.uncertain}
                key={item.caseRef.resourceId}
                onClick={() => review.selectCase(item.caseRef)}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(`${reviewKey}.caseLabel`, {
                  id: item.caseRef.resourceId,
                  name: item.displayName ?? t(`${reviewKey}.unnamed`),
                  state: t(`${reviewKey}.states.${item.lifecycleState}`),
                })}
              </Button>
            ))}
          </>
        )}
        {review.detail.status === 'loading' && (
          <StatusText aria-live="polite">{t(`${reviewKey}.loadingDetail`)}</StatusText>
        )}
        {review.detail.status === 'failed' && (
          <StatusText status="error">{t(`${reviewKey}.${review.detail.failure}`)}</StatusText>
        )}
        {review.detail.status !== 'idle' && (
          <Button
            disabled={review.busy || review.uncertain}
            onClick={() => review.refreshDetail()}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${reviewKey}.reloadDetail`)}
          </Button>
        )}
        {duplicate !== undefined && <ReviewCaseDetail duplicate={duplicate} review={review} />}
        {review.busy && <StatusText aria-live="polite">{t(`${reviewKey}.saving`)}</StatusText>}
        {review.uncertain && (
          <Button
            disabled={review.busy}
            onClick={() => review.checkStatus()}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${reviewKey}.checkStatus`)}
          </Button>
        )}
      </div>
    </SidePanel>
  );
};
