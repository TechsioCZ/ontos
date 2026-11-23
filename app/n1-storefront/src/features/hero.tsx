"use client";

import NextImage from "next/image";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Carousel } from "@techsio/ui-kit/molecules/carousel";
import type { Dictionary } from "@/i18n";

const campaigns = [
  { alt: "heroSale", height: 423, id: "n1-sale", src: "/brand/hero.png", width: 1440 },
  {
    alt: "heroNorthwave",
    height: 469,
    id: "n1-northwave",
    src: "/brand/hero-northwave.webp",
    width: 1600,
  },
  {
    alt: "heroTallboy",
    height: 469,
    id: "n1-tallboy",
    src: "/brand/hero-tallboy.webp",
    width: 1600,
  },
] as const;

export const StorefrontHero = ({ dictionary: d }: { dictionary: Dictionary }) => (
  <Carousel
    aria-label={d.heroAlt}
    aspectRatio="none"
    autoplay={false}
    className="n1-hero-carousel"
    loop
    objectFit="none"
    size="full"
    slideCount={campaigns.length}
    translations={{
      indicator: (index) => `${d.heroSlide} ${index + 1}`,
      item: (index, count) => `${d.heroSlide} ${index + 1} / ${count}`,
      nextTrigger: d.next,
      prevTrigger: d.previous,
    }}
  >
    <Carousel.Slides
      slides={campaigns.map(({ alt, height, id, src, width }, index) => ({
        content: (
          <Image
            alt={d[alt]}
            as={NextImage}
            height={height}
            preload={index === 0}
            size="full"
            sizes="100vw"
            src={src}
            width={width}
          />
        ),
        id,
      }))}
    />
    <div className="absolute top-1/2 left-0 -translate-y-1/2">
      <Carousel.Previous />
    </div>
    <div className="absolute top-1/2 right-0 -translate-y-1/2">
      <Carousel.Next />
    </div>
    <div className="absolute inset-x-0 bottom-0 flex justify-center">
      <Carousel.Indicators className="p-1" />
    </div>
  </Carousel>
);
