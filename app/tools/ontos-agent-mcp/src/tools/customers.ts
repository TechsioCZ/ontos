import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defineTool, VERTICAL } from './shared.ts';
import { readRecords } from '../ontos-client.ts';
import type { CustomerWire } from './wire.ts';

/** party-registry customer-list read; the server caps `limit` at 500. */
export const CUSTOMER_LIMIT = 500;

export const listCustomersInput = {
  search: z
    .string()
    .min(1)
    .optional()
    .describe('Case-insensitive text matched against name, IČO, DIČ, e-mail and city.'),
};

export async function readCustomers(): Promise<readonly CustomerWire[]> {
  const response = (await readRecords(VERTICAL.partyRegistry, 'customer-list', {
    limit: CUSTOMER_LIMIT,
  })) as { items: readonly CustomerWire[] };
  return response.items;
}

export async function listCustomers(input: { readonly search?: string | undefined }) {
  const needle = input.search?.trim().toLocaleLowerCase('cs-CZ');
  const matches = (customer: CustomerWire) =>
    needle === undefined ||
    [customer.displayName, customer.companyId, customer.vatId, customer.email, customer.city].some(
      (field) => field !== null && field.toLocaleLowerCase('cs-CZ').includes(needle),
    );
  const items = (await readCustomers()).filter(matches).map((customer) => ({
    city: customer.city,
    dic: customer.vatId,
    email: customer.email,
    ico: customer.companyId,
    name: customer.displayName,
    partyId: customer.partyId,
    phone: customer.phone,
    status: customer.status,
  }));
  return { count: items.length, items };
}

export function registerCustomerTools(server: McpServer): void {
  defineTool(
    server,
    'list_customers',
    'List current customers (zákazníci) of the legal entity with IČO, DIČ and contact fields. Optional text search. partyId is the id used by orders, opportunities and tasks.',
    listCustomersInput,
    listCustomers,
  );
}
