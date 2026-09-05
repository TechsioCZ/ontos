// expect-count: 1
export const loader = (search: string): string | null => new URLSearchParams(search).get('q');
