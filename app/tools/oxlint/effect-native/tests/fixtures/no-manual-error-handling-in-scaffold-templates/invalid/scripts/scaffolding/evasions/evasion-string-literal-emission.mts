/** The generated program is emitted from string literals joined together instead of a template
 *  literal, so no `TemplateElement` ever carries the switch. The emitted text is identical. */
const CLASSIFIER_LINES = [
  "const readProblem = (error: ReadCoreError) => {",
  "  switch (error._tag) {",
  "    case 'ReadUnavailable': return unavailableProblem();",
  "    default: return internalProblem();",
  "  }",
  "};",
];

export const renderClassifier = (): string => CLASSIFIER_LINES.join("\n");
