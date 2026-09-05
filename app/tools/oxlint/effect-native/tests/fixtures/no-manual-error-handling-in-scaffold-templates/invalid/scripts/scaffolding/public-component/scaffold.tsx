// expect-count: 2
/** Generated frontend code inherits the same classifier; `.tsx` generators are scanned too. */
export const renderPanel = (name: string): string => `
  export const ${name}Panel = () => {
    if (error instanceof PanelLoadError) {
      return <Fallback />;
    }
    return state._tag === 'Ready' ? <Ready /> : <Empty />;
  };
`;
