import { Schema } from 'effect';
import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

interface CrmMoneyFormats {
  readonly formatImportCurrency: (value: number, currency: string) => string;
  readonly formatReportCurrency: (value: number, currency: string) => string;
}

interface CurrencyOptions {
  readonly currency: string;
  readonly maximumFractionDigits?: number;
  readonly minimumFractionDigits: number;
}

const currencyFormatter = (formats: Map<string, Intl.NumberFormat>, options: CurrencyOptions) => {
  const cached = formats.get(options.currency);
  if (cached !== undefined) {
    return cached;
  }
  const format = new Intl.NumberFormat('cs-CZ', { ...options, style: 'currency' });
  formats.set(options.currency, format);
  return format;
};

/** Each mounted CRM page owns its formatters; currencies are cached only after they are displayed. */
const createMoneyFormats = (): CrmMoneyFormats => {
  const importFormats = new Map<string, Intl.NumberFormat>();
  const reportIntegerFormats = new Map<string, Intl.NumberFormat>();
  const reportFractionalFormats = new Map<string, Intl.NumberFormat>();
  return {
    formatImportCurrency: (value, currency) =>
      currencyFormatter(importFormats, {
        currency,
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      }).format(value),
    formatReportCurrency: (value, currency) => {
      if (Number.isInteger(value)) {
        return currencyFormatter(reportIntegerFormats, {
          currency,
          maximumFractionDigits: 2,
          minimumFractionDigits: 0,
        }).format(value);
      }
      return currencyFormatter(reportFractionalFormats, {
        currency,
        minimumFractionDigits: 2,
      }).format(value);
    },
  };
};

const CrmMoneyFormatsContext = createContext<CrmMoneyFormats | null>(null);

class CrmMoneyFormatsProviderMissing extends Schema.TaggedError<CrmMoneyFormatsProviderMissing>()(
  'CrmMoneyFormatsProviderMissing',
  { message: Schema.String },
) {}

export const CrmMoneyFormatsProvider = ({ children }: { readonly children: ReactNode }) => {
  // oxlint-disable-next-line react/hook-use-state -- Pending scoped exception approval: the mount-owned cache needs no setter.
  const [formats] = useState(createMoneyFormats);
  return <CrmMoneyFormatsContext.Provider value={formats}>{children}</CrmMoneyFormatsContext.Provider>;
};

export const useCrmMoneyFormats = (): CrmMoneyFormats => {
  const formats = useContext(CrmMoneyFormatsContext);
  if (formats === null) {
    throw new CrmMoneyFormatsProviderMissing({
      message: 'CRM money formatting requires CrmMoneyFormatsProvider',
    });
  }
  return formats;
};
