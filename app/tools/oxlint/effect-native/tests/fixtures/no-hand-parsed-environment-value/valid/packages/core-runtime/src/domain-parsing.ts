// Parsing values that are not environment-derived stays legal: request bodies, database rows,
// user input and framework-supplied strings all keep their own owners.
interface ContactInput {
  readonly createdAt: string;
  readonly name: string;
  readonly payload: string;
  readonly status: string;
}

export const normalise = (input: ContactInput) => ({
  createdAt: new Date(input.createdAt),
  name: input.name.trim(),
  payload: JSON.parse(input.payload),
  slug: input.name.toLowerCase().split(' ').join('-'),
});

export const isActive = (input: ContactInput) => input.status === 'active';
export const hasName = (input: ContactInput) => input.name.length > 0;
export const requestUrl = (request: { readonly url: string }) => new URL(request.url);
export const asPort = (value: string) => Number(value);
export const decodeRow = (row: { readonly document: string }) => JSON.parse(row.document);
