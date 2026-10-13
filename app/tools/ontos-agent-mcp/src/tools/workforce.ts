import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EMPLOYEE_ROLE_CS, labelOf } from './labels.ts';
import { defineTool, readRecordsOf, VERTICAL } from './shared.ts';
import type { EmployeeWire } from './wire.ts';

export const EMPLOYEE_ROLES = ['SALES_HEAD', 'SALES_REP', 'ACCOUNTANT', 'WAREHOUSE', 'SUPPORT'] as const;

export const listEmployeesInput = {
  role: z
    .enum(EMPLOYEE_ROLES)
    .optional()
    .describe('Filter by role: SALES_HEAD, SALES_REP, ACCOUNTANT, WAREHOUSE, SUPPORT.'),
};

export async function listEmployees(input: { readonly role?: (typeof EMPLOYEE_ROLES)[number] | undefined }) {
  const response = await readRecordsOf<{ items: readonly EmployeeWire[]; revision: number }>(
    VERTICAL.workforce,
    input.role === undefined ? {} : { role: input.role },
  );
  const items = response.items.map((employee) => ({
    active: employee.active,
    department: employee.department,
    email: employee.email,
    id: employee.id,
    name: employee.fullName,
    phone: employee.phone ?? null,
    role: employee.role,
    roleCs: labelOf(EMPLOYEE_ROLE_CS, employee.role),
  }));
  return { count: items.length, items };
}

export function registerWorkforceTools(server: McpServer): void {
  defineTool(
    server,
    'list_employees',
    'List employees (obchodníci, účetní, sklad). Optional role filter. Returns id, name, role and contact fields.',
    listEmployeesInput,
    listEmployees,
  );
}
