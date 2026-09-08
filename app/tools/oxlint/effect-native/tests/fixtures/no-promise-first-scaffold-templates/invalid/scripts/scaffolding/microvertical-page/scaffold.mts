// expect-count: 6
/** A8/A9: the page generator emits a hand-written route parameter record and Promise-first data access. */
export const renderPage = (component: string, parameterType: string): string => `import { useEffect, useState } from 'react';

type ${component}RouteParams = Readonly<Partial<Record<${parameterType}, string>>>;

export const ${component} = ({ routeParams }: { readonly routeParams: ${component}RouteParams }) => {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    const load = async () => {
      const response = await fetch('/api/rows');
      setRows(await response.json());
    };
    void load().then(() => undefined);
  }, []);

  return rows;
};
`;
