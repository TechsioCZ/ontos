export const AccountingDraftEntryCard = () => (
  <article
    className="accountingcore:rounded-lg accountingcore:border accountingcore:border-stone-900/10 accountingcore:bg-white accountingcore:p-4 accountingcore:shadow-sm"
    data-modern-boundary-id="verticalAccountingCore"
    data-modern-mf-expose="./AccountingDraftEntryCard"
    data-ontos-component-id="AccountingDraftEntryCard"
    data-ontos-module-id="accounting.core"
  >
    <p className="accountingcore:text-xs accountingcore:font-bold accountingcore:uppercase accountingcore:text-stone-500">
      accounting.draft_entry
    </p>
    <h3 className="accountingcore:mt-2 accountingcore:text-lg accountingcore:font-black accountingcore:text-stone-950">
      draft-entry:probe-001
    </h3>
    <dl className="accountingcore:mt-3 accountingcore:grid accountingcore:grid-cols-2 accountingcore:gap-3 accountingcore:text-sm">
      <div>
        <dt className="accountingcore:font-semibold accountingcore:text-stone-500">Counterparty</dt>
        <dd className="accountingcore:mt-1 accountingcore:font-bold accountingcore:text-stone-950">
          Property operations escrow
        </dd>
      </div>
      <div>
        <dt className="accountingcore:font-semibold accountingcore:text-stone-500">Amount</dt>
        <dd className="accountingcore:mt-1 accountingcore:font-bold accountingcore:text-stone-950">
          CZK 12,480.00
        </dd>
      </div>
    </dl>
    <p className="accountingcore:mt-4 accountingcore:inline-flex accountingcore:rounded-full accountingcore:border accountingcore:border-sky-900/15 accountingcore:bg-sky-50 accountingcore:px-3 accountingcore:py-1 accountingcore:text-xs accountingcore:font-bold accountingcore:text-sky-950">
      probe-only
    </p>
  </article>
);

export default AccountingDraftEntryCard;
