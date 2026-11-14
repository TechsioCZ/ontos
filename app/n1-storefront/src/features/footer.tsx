"use client";

import NextImage from "next/image";
import NextLink from "next/link";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Footer } from "@techsio/ui-kit/organisms/footer";
import type { Dictionary } from "@/i18n";

/** Existing Footer anatomy; all visual configuration lives in app tokens. */
export const StorefrontFooter = ({
  dictionary: d,
  locale,
}: {
  dictionary: Dictionary;
  locale: string;
}) => (
  <Footer direction="vertical" layout="col" sectionFlow="col" size="md">
    <div className="w-full p-4">
      <Footer.Container>
        <Footer.Section>
          <div className="relative aspect-n1-footer-logo w-full md:max-w-n1-footer-logo">
            <Image
              alt="N1 shop"
              as={NextImage}
              fill
              loading="eager"
              size="full"
              sizes="(min-width: 48rem) 322px, calc(100vw - 2rem)"
              src="/brand/logo-footer.png"
            />
          </div>
          <div className="flex items-start gap-2">
            <Image
              alt=""
              as={NextImage}
              height={16}
              size="custom"
              src="/brand/map-marker.svg"
              width={16}
            />
            <div>
              <Footer.Text>{d.contactHeading}</Footer.Text>
              <div className="n1-footer-address">
                <Footer.Text>{d.address}</Footer.Text>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Image
              alt=""
              as={NextImage}
              height={16}
              size="custom"
              src="/brand/phone.svg"
              width={16}
            />
            <Footer.Link href="tel:+420244402795">+420 244 402 795</Footer.Link>
          </div>
          <div className="flex items-center gap-2">
            <Image
              alt=""
              as={NextImage}
              height={16}
              size="custom"
              src="/brand/email.svg"
              width={16}
            />
            <Footer.Link href="mailto:office@ndistribution.cz">office@ndistribution.cz</Footer.Link>
          </div>
          <div className="flex items-center gap-2">
            <Image
              alt=""
              as={NextImage}
              height={16}
              size="custom"
              src="/brand/clock.svg"
              width={16}
            />
            <Footer.Text>{d.openingHours}</Footer.Text>
          </div>
        </Footer.Section>
        <Footer.Section className="n1-footer-navigation">
          <Footer.Title>{d.terms}</Footer.Title>
          <Footer.List>
            {[
              ["ochrana-osobnich-udaju", d.privacy],
              ["platba", d.payment],
              ["doprava", d.shipping],
            ].map(([slug, label]) => (
              <li className="flex" key={slug}>
                <Footer.Link as={NextLink} href={`/${locale}/${slug}`}>
                  {label}
                </Footer.Link>
              </li>
            ))}
            <li className="flex">
              <Footer.Link
                aria-label={`${d.cookiesSettings}: ${d.featureUnavailable}`}
                as="button"
                disabled
                type="button"
              >
                {d.cookiesSettings}
              </Footer.Link>
            </li>
          </Footer.List>
        </Footer.Section>
        <Footer.Section>
          <Footer.Title>{d.cookiesRecall}</Footer.Title>
        </Footer.Section>
        <Footer.Section>
          <Footer.Title>{d.news}</Footer.Title>
        </Footer.Section>
      </Footer.Container>
    </div>
    <div className="n1-footer-bottom w-full">
      <Footer.Bottom>
        <div className="min-w-0 flex-1">
          <Footer.Text>{d.copyright}</Footer.Text>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 md:flex-none">
          <div className="min-w-0 flex-1 md:flex-none">
            <Footer.Text>{d.credit}</Footer.Text>
          </div>
          <Image
            alt=""
            as={NextImage}
            height={17}
            size="custom"
            src="/brand/web-revolution.png"
            width={32}
          />
        </div>
      </Footer.Bottom>
    </div>
  </Footer>
);
