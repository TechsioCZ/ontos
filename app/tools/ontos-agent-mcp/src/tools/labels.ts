// Enum codes as they appear on the wire, with Czech labels for the chat. Codes stay in every output too.

/** Czech label for an enum code. Unknown codes pass through unchanged. */
export const labelOf = (labels: Readonly<Record<string, string>>, code: string): string => labels[code] ?? code;

export const EMPLOYEE_ROLE_CS: Readonly<Record<string, string>> = {
  ACCOUNTANT: 'účetní',
  SALES_HEAD: 'vedoucí obchodu',
  SALES_REP: 'obchodník',
  SUPPORT: 'podpora',
  WAREHOUSE: 'sklad',
};

export const OPPORTUNITY_STAGE_CS: Readonly<Record<string, string>> = {
  LEAD: 'lead',
  LOST: 'prohraná',
  NEGOTIATION: 'jednání',
  PROPOSAL: 'nabídka',
  QUALIFIED: 'kvalifikovaná',
  WON: 'vyhraná',
};

export const TASK_STATE_CS: Readonly<Record<string, string>> = {
  CANCELLED: 'zrušen',
  DONE: 'splněn',
  IN_PROGRESS: 'probíhá',
  NEW: 'nový',
  WAITING: 'čeká',
};

export const ORDER_STATUS_CS: Readonly<Record<string, string>> = {
  CANCELLED: 'zrušena',
  CONFIRMED: 'potvrzena',
  DELIVERED: 'doručena',
  NEW: 'nová',
  SHIPPED: 'odeslána',
};

export const INVOICE_STATE_CS: Readonly<Record<string, string>> = {
  CONFIRMED: 'vystavena',
  DRAFT: 'koncept',
  VOIDED: 'stornována',
};

export const PAYMENT_STATE_CS: Readonly<Record<string, string>> = {
  PAID: 'zaplaceno',
  PARTIALLY_PAID: 'částečně zaplaceno',
  UNPAID: 'nezaplaceno',
};

export const METRIC_GROUPING_CS: Readonly<Record<string, string>> = {
  customer: 'zákazník',
  day: 'den',
  employee: 'obchodník',
  month: 'měsíc',
  product: 'produkt',
  stage: 'fáze',
  tag: 'štítek',
  week: 'týden',
};
