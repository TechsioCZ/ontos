const columns = 2;

export const KitClasses = ({ open }: { open: boolean }) => (
  <section className="grid gap-200 sm:grid-cols-2 group">
    <p className={open ? 'text-fg-secondary' : 'hover:bg-surface'}>a</p>
    <p className={`w-1/2 ${open ? 'p-400' : ''} [&_svg]:size-4`}>b</p>
    <p className={`grid-cols-${columns} gap-200`}>c</p>
    <p className={['bg-surface', open && 'dark'].join(' ')}>d</p>
    <p className="2xl:hidden group/row peer">e</p>
  </section>
);
