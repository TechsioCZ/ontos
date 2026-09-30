"use client";

import Image from "next/image";
import NextLink from "next/link";
import { useRef, useState } from "react";
import { Carousel } from "@techsio/ui-kit/molecules/carousel";

import { cs } from "@/i18n/cs";
import { homeCarouselSlides } from "@/mock-storefront/fixtures/home-carousel";

export function HomeCarousel() {
  const [activePage, setActivePage] = useState(0);
  const wasDragged = useRef(false);
  const slides = homeCarouselSlides.map((slide, index) => {
    const image = (
      <Image
        alt={slide.alt}
        className="block h-auto w-full"
        draggable={false}
        fetchPriority={index === 0 ? "high" : "auto"}
        height={260}
        loading={index === 0 ? "eager" : "lazy"}
        sizes="(max-width: 760px) calc(100vw - 24px), (max-width: 1663px) calc(100vw - 336px), 1327px"
        src={slide.src}
        width={933}
      />
    );

    return {
      id: slide.id,
      content: slide.href ? (
        <NextLink
          className="block w-full"
          href={slide.href}
          onClick={(event) => {
            if (event.detail > 0 && wasDragged.current) event.preventDefault();
            wasDragged.current = false;
          }}
          tabIndex={index === activePage ? 0 : -1}
        >
          {image}
        </NextLink>
      ) : (
        image
      ),
    };
  });

  return (
    <section aria-labelledby="home-carousel-title" data-akros-home-carousel>
      <h1 className="sr-only" id="home-carousel-title">
        {cs.home.companyTitle}
      </h1>
      <Carousel
        aspectRatio="none"
        autoplay={false}
        className="w-full"
        id="home-carousel"
        loop
        objectFit="none"
        onPageChange={({ page }) => setActivePage(page)}
        onDragStatusChange={({ type }) => {
          if (type === "dragging.start") wasDragged.current = false;
          if (type === "dragging") wasDragged.current = true;
        }}
        size="full"
        slideCount={slides.length}
        translations={cs.home.carousel}
      >
        <Carousel.Slides slides={slides} />
        <Carousel.Control
          className="pointer-events-none absolute inset-0 items-center justify-between px-3 max-md:px-1"
          controlPosition="unset"
        >
          <Carousel.Previous className="pointer-events-auto size-(--dimension-44) text-(length:--text-carousel-trigger) text-carousel-trigger-fg-base" />
          <Carousel.Next className="pointer-events-auto size-(--dimension-44) text-(length:--text-carousel-trigger) text-carousel-trigger-fg-base" />
        </Carousel.Control>
        <Carousel.Control className="pointer-events-none w-full">
          <Carousel.Indicators className="pointer-events-none">
            {slides.map((slide, index) => (
              <Carousel.Indicator
                className="group pointer-events-auto flex items-center justify-center bg-transparent data-current:bg-transparent max-md:items-end max-md:pb-1"
                index={index}
                key={slide.id}
              >
                <span
                  aria-hidden="true"
                  className="size-(--size-carousel-indicator) rounded-carousel-indicator bg-carousel-indicator-bg-base group-data-current:bg-carousel-indicator-bg-active"
                />
              </Carousel.Indicator>
            ))}
          </Carousel.Indicators>
        </Carousel.Control>
      </Carousel>
    </section>
  );
}
