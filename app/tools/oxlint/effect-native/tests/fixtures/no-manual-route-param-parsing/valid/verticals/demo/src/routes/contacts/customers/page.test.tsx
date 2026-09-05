import { useParams } from '@modern-js/plugin-tanstack/runtime';

// Tests are out of scope: the audit's D tier keeps test-only shapes as they are.
export const renderHarness = (search: string) => {
  const parameters = new URLSearchParams(search);
  const body = new FormData();
  const params = useParams({ strict: false });
  const url = new URL('https://example.test/x?q=1');
  return { offset: parameters.get('offset'), params, query: url.searchParams.get('q'), body };
};
