// expect-count: 3
import { dedent } from "./dedent.ts";

/** Tagged template: the emitted text is scanned exactly like a plain template literal. */
export const renderPageLoader = (route: string): string =>
  dedent`
    export const load = () =>
      client.read({ route: '${route}' }).catch((error) => {
        if (error._tag === 'ReadUnavailable') {
          return fallback();
        }
        return null;
      });
  `;

/** Nested template with escaped delimiters: cooked !== raw, so the report falls back to the element. */
export const renderNestedLabel = (): string => `
  const inner = (error: unknown) =>
    \`\${label}: \` + (error instanceof RenderError ? 'boom' : 'ok');
`;
