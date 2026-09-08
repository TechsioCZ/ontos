// expect-count: 5
/** A generator whose emitted worker reads ambient configuration directly. */
export const renderReportWorker = (slug: string): string => `
import 'dotenv/config';

const pageSize = Number.parseInt(process.env.ONTOS_REPORT_PAGE_SIZE ?? '50', 10);
const endpoint = new URL(process.env['ONTOS_REPORT_ENDPOINT'] ?? 'http://localhost');

export const runReport = async () => {
  if (Number.isNaN(pageSize)) {
    throw new ReportConfigurationError('ONTOS_REPORT_PAGE_SIZE must be an integer');
  }
  return { slug: '${slug}', endpoint: endpoint.href, pageSize };
};
`;
