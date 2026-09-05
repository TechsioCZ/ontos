/** Golden-output tests quote the current generator output verbatim; test files are never scanned. */
export const expectedPage = `type CustomersPageRouteParams = Readonly<Partial<Record<'customerId', string>>>;

export const load = async () => {
  const response = await fetch('/api/customers');
  return response.json().then((rows) => rows);
};
`;
