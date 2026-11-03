"use client";

import NextImage from "next/image";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Carousel } from "@techsio/ui-kit/molecules/carousel";
import type { Dictionary } from "@/i18n";

/** Only the supplied campaign asset; pagination never invents additional slides. */
export const StorefrontHero = ({ dictionary: d }: { dictionary: Dictionary }) => (
  <Carousel
    aria-label={d.heroAlt}
    aspectRatio="none"
    autoplay={false}
    loop={false}
    objectFit="none"
    size="full"
    slideCount={1}
    translations={{
      indicator: (index) => `${d.heroSlide} ${index + 1}`,
      item: (index, count) => `${d.heroSlide} ${index + 1} / ${count}`,
      nextTrigger: d.next,
      prevTrigger: d.previous,
    }}
  >
    <Carousel.Slides
      slides={[
        {
          content: (
            <Image
              alt={d.heroAlt}
              as={NextImage}
              height={423}
              priority
              size="full"
              src="/brand/hero.png"
              width={1440}
            />
          ),
          id: "n1-sale",
        },
      ]}
    />
    <div className="absolute top-1/2 left-0 -translate-y-1/2">
      <Carousel.Previous />
    </div>
    <div className="absolute top-1/2 right-0 -translate-y-1/2">
      <Carousel.Next />
    </div>
    <div className="absolute inset-x-0 bottom-0 flex justify-center">
      <Carousel.Indicators />
    </div>
  </Carousel>
);
