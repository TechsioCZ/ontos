// The contract form of the agreements page: a new contract, or the period of a draft contract.
import type { Contract } from '../../../../shared/apis/records.ts';
import { ContractCreatePanel } from './contract-create-panel.tsx';
import { ContractPeriodPanel } from './contract-period-panel.tsx';
import type { useRecordsPage } from './use-agreements-records.ts';

type PageState = ReturnType<typeof useRecordsPage>;

const ContractCreateForm = ({ kind, state }: { readonly kind: Contract['kind']; readonly state: PageState }) => {
  const { t, unitName } = state;
  const confirmedLeases = (state.occupancies?.occupancies ?? []).filter(
    (record) => record.kind === 'LONG_TERM_LEASE' && record.state === 'CONFIRMED',
  );
  const handleCreate = state.createContract;
  const handleClose = state.closeDraftForm;
  const handleCreated = state.openCreated;
  const handleKindChange = state.selectContractKind;
  return (
    <ContractCreatePanel
      customers={state.customers.flatMap((item) =>
        item.status === 'ACTIVE'
          ? [{ label: item.displayName ?? t('legal-agreements.demo.unnamedCustomer'), value: item.partyId }]
          : [],
      )}
      kind={kind}
      leases={confirmedLeases.map((record) => ({
        endDate: record.endDate ?? '',
        label: unitName(record.unitRef.resourceId),
        startDate: record.startDate,
        value: record.occupancyRef.resourceId,
      }))}
      onClose={handleClose}
      onCreate={handleCreate}
      onCreated={handleCreated}
      onKindChange={handleKindChange}
      references={{
        customers: state.customers,
        occupancies: state.occupancies?.occupancies ?? [],
        units: state.properties?.units ?? [],
      }}
      rentalFeedback={
        state.rentalFeedback === undefined ? undefined : t(`legal-agreements.demo.feedback.${state.rentalFeedback}`)
      }
    />
  );
};

/** The open contract form of the page, if any. Each opening starts a new draft. */
export const AgreementsDraftForm = ({ state }: { readonly state: PageState }) => {
  const form = state.draftForm;
  if (form === undefined) {
    return null;
  }
  if (form.mode === 'create') {
    return <ContractCreateForm kind={form.kind} state={state} />;
  }
  const { contractRef } = form.contract;
  // The page's newest read of the contract; the one the form was opened with while the page hides its data.
  const contract = state.selected?.contractRef.resourceId === contractRef.resourceId ? state.selected : form.contract;
  const handleSave = state.savePeriod;
  const handleClose = state.closeDraftForm;
  return (
    <ContractPeriodPanel
      contract={contract}
      key={contractRef.resourceId}
      label={
        contract.kind === 'OTHER'
          ? state.t('legal-agreements.demo.kinds.OTHER')
          : state.unitName(contract.unitRef?.resourceId)
      }
      onClose={handleClose}
      onSave={handleSave}
      reload={state.refreshAgreements}
      revision={state.snapshot?.revision ?? 0}
    />
  );
};
