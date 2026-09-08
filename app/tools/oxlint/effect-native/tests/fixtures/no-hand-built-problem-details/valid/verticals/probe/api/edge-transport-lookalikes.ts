// Statuses that are not RFC 9457 payloads: transport envelopes, domain entities, log records.
declare const error: { readonly message: string };
declare const rows: readonly { readonly title: string }[];

export const created = { location: '/contacts/1', status: 201 };

export const serverError = { status: 500 };

export const entity = { status: 'active', title: 'Acme s.r.o.' };

export const logLine = { level: 'error', message: error.message, operation: 'contacts.read' };

export const paged = { data: rows, status: 200, total: rows.length };

// Out of `statusRange`: a workflow priority, not an HTTP status.
export const priority = { status: 3, title: 'Follow up' };
