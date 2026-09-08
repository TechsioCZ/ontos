/** TSX generator with JSX in both the generator and the emitted text, and no manual failure
 *  discrimination anywhere. */
export const renderPanel = (name: string): string => `
export const ${name}Panel = () => {
  const problem = Match.type<ReadCoreError>().pipe(
    Match.tag('ReadUnavailable', () => <Unavailable />),
    Match.exhaustive,
  );
  return <section className="panel">{problem(error)}</section>;
};
`;

export const Preview = (): unknown => <article data-label={`${"_tag"} preview`}>{"ok"}</article>;
