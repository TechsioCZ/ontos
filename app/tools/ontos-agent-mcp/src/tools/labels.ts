// Enum codes as they appear on the wire, with Czech labels for the chat. Codes stay in every output too.

/** Czech label for an enum code. Unknown codes pass through unchanged. */
export const labelOf = (labels: Readonly<Record<string, string>>, code: string): string => labels[code] ?? code;

export const EMPLOYEE_ROLE_CS = {
  ACCOUNTANT: 'účetní',
  SALES_HEAD: 'vedoucí obchodu',
  SALES_REP: 'obchodník',
  SUPPORT: 'podpora',
  WAREHOUSE: 'sklad',
};

export const OPPORTUNITY_STAGE_CS = {
  LEAD: 'lead',
  LOST: 'prohraná',
  NEGOTIATION: 'jednání',
  PROPOSAL: 'nabídka',
  QUALIFIED: 'kvalifikovaná',
  WON: 'vyhraná',
};

export const TASK_STATE_CS = {
  CANCELLED: 'zrušen',
  DONE: 'splněn',
  IN_PROGRESS: 'probíhá',
  NEW: 'nový',
  WAITING: 'čeká',
};

export const ORDER_STATUS_CS = {
  CANCELLED: 'zrušena',
  CONFIRMED: 'potvrzena',
  DELIVERED: 'doručena',
  NEW: 'nová',
  SHIPPED: 'odeslána',
};

export const INVOICE_STATE_CS = {
  CONFIRMED: 'vystavena',
  DRAFT: 'koncept',
  VOIDED: 'stornována',
};

export const PAYMENT_STATE_CS = {
  PAID: 'zaplaceno',
  PARTIALLY_PAID: 'částečně zaplaceno',
  UNPAID: 'nezaplaceno',
};

export const METRIC_GROUPING_CS = {
  customer: 'zákazník',
  day: 'den',
  employee: 'obchodník',
  month: 'měsíc',
  product: 'produkt',
  stage: 'fáze',
  tag: 'štítek',
  week: 'týden',
};
