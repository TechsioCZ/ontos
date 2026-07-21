// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from './sql-result.ts';
import { sql } from './db/sql.ts';
import type { CoreReadonlyDbExecutor } from './db/types.ts';

export interface ResolvedPersonDirectoryEntry {
  readonly displayName: string;
  readonly eligible: boolean;
  readonly principalId: string;
  readonly status: 'active' | 'archived' | 'disabled' | 'departed';
}

export interface EligiblePersonDirectoryEntry {
  readonly displayName: string;
  readonly email?: string;
  readonly login?: string;
  readonly principalId: string;
}

interface PersonDirectoryRow {
  readonly displayName: string;
  readonly kind: string;
  readonly membershipStatus: 'active' | 'departed' | null;
  readonly principalId: string;
  readonly principalStatus: 'active' | 'archived' | 'disabled';
}

export interface PersonDirectory {
  readonly eligiblePrincipalIds: (principalIds: readonly string[]) => Promise<ReadonlySet<string>>;
  readonly resolveStoredPrincipalIds: (
    principalIds: readonly string[],
  ) => Promise<readonly ResolvedPersonDirectoryEntry[]>;
  readonly searchEligiblePeople: (
    query: string,
  ) => Promise<readonly EligiblePersonDirectoryEntry[]>;
}

interface EligiblePersonDirectoryRow {
  readonly displayName: string;
  readonly email: string | null;
  readonly emailVisible: boolean;
  readonly login: string | null;
  readonly loginVisible: boolean;
  readonly principalId: string;
}

const publicStatus = (row: PersonDirectoryRow): ResolvedPersonDirectoryEntry['status'] =>
  row.membershipStatus === 'departed' ? 'departed' : row.principalStatus;

const isEligible = (row: PersonDirectoryRow) =>
  row.kind === 'human' && row.principalStatus === 'active' && row.membershipStatus === 'active';

const directoryRows = async ({
  db,
  principalIds,
  tenantId,
}: {
  readonly db: CoreReadonlyDbExecutor;
  readonly principalIds: readonly string[];
  readonly tenantId: string;
}): Promise<readonly PersonDirectoryRow[]> => {
  if (principalIds.length === 0) {
    return [];
  }
  const result = await db.execute(sql`
      select
        principal.display_name as "displayName",
        principal.kind,
        entry.membership_status as "membershipStatus",
        principal.principal_id as "principalId",
        principal.status as "principalStatus"
      from core.principals as principal
      left join core.principal_directory_entries as entry
        on entry.principal_id = principal.principal_id
        and entry.tenant_id = principal.tenant_id
      where principal.tenant_id = ${tenantId}
        and principal.principal_id in (
          select value::uuid
          from jsonb_array_elements_text(${JSON.stringify(principalIds)}::jsonb)
        )
    `);
  return rowsFromResult<PersonDirectoryRow>(result);
};

export const createPersonDirectory = ({
  db,
  tenantId,
  viewerPrincipalId,
}: {
  readonly db: CoreReadonlyDbExecutor;
  readonly tenantId: string;
  readonly viewerPrincipalId?: string;
}): PersonDirectory => ({
  eligiblePrincipalIds: async (principalIds) => {
    const rows = await directoryRows({ db, principalIds, tenantId });
    return new Set(rows.filter(isEligible).map(({ principalId }) => principalId));
  },
  resolveStoredPrincipalIds: async (principalIds) => {
    const order = new Map(principalIds.map((principalId, index) => [principalId, index]));
    const rows = await directoryRows({ db, principalIds, tenantId });
    return rows
      .map((row) => ({
        displayName: row.displayName,
        eligible: isEligible(row),
        principalId: row.principalId,
        status: publicStatus(row),
      }))
      .toSorted(
        (left, right) =>
          (order.get(left.principalId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.principalId) ?? Number.MAX_SAFE_INTEGER),
      );
  },
  searchEligiblePeople: async (query) => {
    if (viewerPrincipalId === undefined) {
      return [];
    }
    const searchTerm = query.trim().normalize('NFC').toLocaleLowerCase();
    const result = await db.execute(sql`
      select
        principal.display_name as "displayName",
        entry.email,
        coalesce(visibility.email_visible, false) as "emailVisible",
        entry.login,
        coalesce(visibility.login_visible, false) as "loginVisible",
        principal.principal_id as "principalId"
      from core.principals as principal
      inner join core.principal_directory_entries as entry
        on entry.principal_id = principal.principal_id
        and entry.tenant_id = principal.tenant_id
      left join core.principal_directory_field_visibility as visibility
        on visibility.subject_principal_id = principal.principal_id
        and visibility.viewer_principal_id = ${viewerPrincipalId}
        and visibility.tenant_id = principal.tenant_id
      where principal.tenant_id = ${tenantId}
        and principal.kind = 'human'
        and principal.status = 'active'
        and entry.membership_status = 'active'
        and (
          ${searchTerm} = ''
          or position(${searchTerm} in lower(principal.display_name)) > 0
          or (
            coalesce(visibility.email_visible, false)
            and position(${searchTerm} in lower(coalesce(entry.email, ''))) > 0
          )
          or (
            coalesce(visibility.login_visible, false)
            and position(${searchTerm} in lower(coalesce(entry.login, ''))) > 0
          )
        )
      order by lower(principal.display_name), principal.principal_id
    `);
    return rowsFromResult<EligiblePersonDirectoryRow>(result).map((row) => ({
      displayName: row.displayName,
      ...(row.emailVisible && row.email !== null ? { email: row.email } : {}),
      ...(row.loginVisible && row.login !== null ? { login: row.login } : {}),
      principalId: row.principalId,
    }));
  },
});
