// Shell Home public component. All facts come from the same governed, ACL-projected read as CRM pages.
import { SectionCard, StatCard, StatRow, formatNumber } from '@app/admin-ui';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { canSeeEverything } from '../../shared/domain/access.ts';
import { buildCrmHomeSummary } from '../../shared/domain/reports.ts';
import { crmI18nResources } from '../crm/i18n.ts';
import { useCrmRecords } from '../crm/records.ts';
import { CrmStateGate } from '../crm/ui.tsx';
import { formatDecimalMoney } from '../routes/[lang]/crm/prehled-prodeju/report-format.ts';
import '../routes/index.css';

const HomeFacts = ({ records }: { readonly records: RecordsResponse }) => {
  const { language } = useModernI18n();
  const lang = language ?? 'cs';
  const all = canSeeEverything(records.viewer);
  const facts = buildCrmHomeSummary(records);
  return (
    <div className="flex min-w-0 flex-col gap-250">
      <div className="flex flex-wrap items-center justify-between gap-150">
        <div className="flex flex-wrap items-center gap-150">
          <h2 className="font-semibold text-lg">CRM v kostce</h2>
          <Badge size="sm" variant="info">
            {all ? 'Klienti firmy' : 'Jen moji klienti'}
          </Badge>
        </div>
        <a className="text-sm underline underline-offset-2" href={`/${lang}/crm/prehled-prodeju`}>
          Přehled prodejů →
        </a>
      </div>
      <StatRow>
        <StatCard
          label={all ? 'Aktivní klienti firmy' : 'Moji aktivní klienti'}
          value={formatNumber(facts.clients)}
          hint="Bez archivovaných klientů"
        />
        <StatCard
          label="K oslovení dnes"
          value={formatNumber(facts.dueToday)}
          hint={`${formatNumber(facts.overdue)} po termínu · pouze ruční plán`}
        />
        <StatCard
          label="Otevřené kontakty"
          value={formatNumber(facts.openContacts)}
          hint="Ručně naplánované, dosud nevyřízené"
        />
        {all && (
          <StatCard
            label="Objednávky k dořešení"
            value={formatNumber(facts.toResolve ?? 0)}
            hint="Nespárované, sporné vazby a možné duplicity"
          />
        )}
      </StatRow>
      <SectionCard title="Hodnota objednávek tento měsíc">
        <p className="text-fg-secondary text-sm">
          Pouze spárované importované objednávky bez duplicit. Každá měna zvlášť; nejde o tržbu ani zisk. Bez částky:{' '}
          {formatNumber(facts.month.withoutAmount)}.
        </p>
        <StatRow>
          {facts.month.totals.length === 0 ? (
            <StatCard
              label="Hodnota evidovaných objednávek"
              value="Bez dat"
              hint="Tento měsíc nejsou objednávky s poskytnutou částkou a měnou"
            />
          ) : (
            facts.month.totals.map((total) => (
              <StatCard
                key={total.currency}
                label={`Hodnota v ${total.currency}`}
                value={formatDecimalMoney(total.amount, total.currency)}
                hint={`${formatNumber(total.count)} objednávek · včetně případných storen`}
              />
            ))
          )}
        </StatRow>
      </SectionCard>
      <div className="flex flex-wrap gap-150">
        <a className="text-sm underline underline-offset-2" href={`/${lang}/crm/klienti`}>
          Otevřít klienty
        </a>
        <a className="text-sm underline underline-offset-2" href={`/${lang}/crm/k-osloveni`}>
          Ruční plán kontaktů
        </a>
        {all && (
          <a className="text-sm underline underline-offset-2" href={`/${lang}/crm/parovani`}>
            Dořešit párování objednávek
          </a>
        )}
      </div>
    </div>
  );
};

const HomeSummaryContent = () => {
  const { load, state } = useCrmRecords();
  return (
    <SectionCard
      actions={
        <Button onClick={load} size="sm" theme="outlined" variant="secondary">
          Obnovit údaje
        </Button>
      }
      title="Obchodní přehled"
    >
      <CrmStateGate onRetry={load} state={state}>
        {(records) => <HomeFacts records={records} />}
      </CrmStateGate>
    </SectionCard>
  );
};

export const HomeSummary = () => (
  <FederatedI18nBoundary
    defaultNamespace="crm"
    fallbackLanguage="cs"
    resources={crmI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <HomeSummaryContent />
  </FederatedI18nBoundary>
);
export default HomeSummary;
