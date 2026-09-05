// expect-count: 3
// Evasion by naming: the audit's A3 text names "Bearer tokens" explicitly, but the default
// `secretNames` regex has no `authorization`/`bearer` alternative. In this repository the raw
// `Authorization: Bearer <jwt>` header is threaded through ~16 production signatures under
// exactly this name (verticals/contacts/src/api/*.ts, apps/shell-super-app/api/modules/
// shell-resources.ts), and every one of them is silent today.
export interface ContactsClientOptions {
  readonly appId: string;
  readonly authorization: string;
}

export const callGateway = (authorization: string | undefined): string => String(authorization);

export class GatewaySession {
  readonly authorization: string = '';
}
