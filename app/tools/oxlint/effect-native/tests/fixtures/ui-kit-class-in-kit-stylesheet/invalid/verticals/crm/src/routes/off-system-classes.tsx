// expect-count: 6
export const OffSystem = ({ open }: { open: boolean }) => (
  <section className="crm:grid crm:gap-4 grid">
    <p className={open ? 'text-stone-600' : 'bg-[#fff]'}>a</p>
    <p className={`w-1/2 ${open ? 'p-5' : ''} mt-2`}>b</p>
  </section>
);
