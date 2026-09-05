/** Decorators and class members holding templates: parsed, scanned, never reported. */
const traced = (value: unknown): unknown => value;

export class TemplateRenderer {
  @traced
  accessor header = `import { Effect, Match } from 'effect';`;

  render(stem: string): string {
    return `${this.header}
export const ${stem}Problem = Schema.TaggedError<${stem}Problem>()('${stem}Problem', {});
`;
  }
}
