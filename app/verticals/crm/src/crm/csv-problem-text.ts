import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { CsvProblem } from '../../shared/domain/imports.ts';
import { renderCsvProblem } from '../../shared/imports/csv-problem.ts';

/** CSV import problems in the screen's language (keys under crm.imports.csv). */
export const useCsvProblemText = () => {
  const { t } = useModernI18n();
  return (problem: CsvProblem) => renderCsvProblem((key, values) => t(`crm.imports.csv.${key}`, values), problem);
};

/** A stored row text: refusals carry a problem code; other outcomes (and older batches) only the stored sentence. */
export const useImportRowText = () => {
  const problemText = useCsvProblemText();
  return (entry: { readonly message: string; readonly problem?: CsvProblem }) =>
    entry.problem === undefined ? entry.message : problemText(entry.problem);
};
