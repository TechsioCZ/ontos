// expect-count: 8
export const Palette = ({ active }: { active: boolean }) => (
  <section className="catalog:rounded-2xl catalog:bg-white/90 catalog:shadow-stone-900/10">
    <h2 className={active ? 'hover:text-red-500' : 'text-fg-primary'}>Title</h2>
    <p className={`mt-2 ${active ? 'x' : 'y'} border-x-slate-200`}>Body</p>
    <span className="bg-[#ff0000]" />
    <span className="text-[rgb(0_0_0)]" />
    <span data-colour="#1f2937" />
    <span className="!bg-black" />
  </section>
);
