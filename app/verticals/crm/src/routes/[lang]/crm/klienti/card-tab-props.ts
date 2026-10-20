// Contract of the client-card tab slots (owned by crm-clients). The card renders
//   Návštěvy   -> ClientVisitsTab  from ../navstevy/client-visits-tab.tsx  (owner: crm-visits)
//   Objednávky -> ClientOrdersTab  from ../importy/client-orders-tab.tsx   (owner: crm-imports)
// Both receive the ACL-projected records of the signed-in principal and the shared submit of the card.
import type { CrmCommand } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';
import type { CrmCommandOutcome } from '../../../../crm/records.ts';

export interface ClientCardTabProps {
  readonly busy: boolean;
  readonly client: Client;
  readonly records: RecordsResponse;
  /** Runs one CRM command against the current revision and reloads the records. */
  readonly submit: (command: CrmCommand) => Promise<CrmCommandOutcome>;
}
