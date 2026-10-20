import Image from "next/image";

interface GalleryItem {
  src: string;
  alt: string;
  caption: string;
}

export function ContentGallery({ items }: { items: readonly GalleryItem[] }) {
  return (
    <div className="akros-content-gallery">
      {items.map((item) => (
        <figure key={item.src}>
          <Image
            alt={item.alt}
            height={460}
            loading="lazy"
            sizes="(max-width: 760px) 100vw, 360px"
            src={item.src}
            width={720}
          />
          <figcaption>{item.caption}</figcaption>
        </figure>
      ))}
    </div>
  );
}
