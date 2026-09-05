// expect-count: 5
/**
 * Positive control: the emitted text is reached through a tagged template, a nested template inside an
 * interpolation, a class property and a static class member, in a .tsx file.
 */
const outdent = (parts: TemplateStringsArray, ...values: readonly string[]): string =>
	parts.reduce((accumulator, part, index) => accumulator + part + (values[index] ?? ''), '');

export class PageScaffold {
	readonly render = (component: string): string =>
		outdent`export const ${component} = () => {
  const rows = ${`useSWR('/api/rows', (url) => fetch(url).then((response) => response.json()))`};
  return rows;
};
`;

	static readonly renderBoundary = (name: string): string => String.raw`export async function ${name}Boundary() {
  return await Effect.runPromise(${name}Program);
}
`;
}
