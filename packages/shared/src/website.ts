import { z } from 'zod';

export const sectionKeys = ['featured', 'latest', 'categories', 'interviews', 'videos', 'magazine'] as const;
export const englishLabels = {
  home: 'Home',
  latest: 'Latest news',
  news: 'News',
  featured: 'Featured news',
  categories: 'Categories',
  interviews: 'Interviews',
  videos: 'Videos',
  magazine: 'Magazine',
  search: 'Search',
  languages: 'Languages',
  popularLanguages: 'Popular languages',
  unavailable: 'Translation unavailable',
  share: 'Share',
  related: 'Related news',
  empty: 'No articles have been published yet.',
  demo: 'Demonstration content',
  feed: 'RSS feed',
  next: 'Next',
  previous: 'Previous',
  notFound: 'Page not found',
  advertisement: 'Advertisement',
  menu: 'Menu',
  subscribe: 'Subscribe',
  darkMode: 'Dark mode',
  usefulLinks: 'Useful links',
  followUs: 'Follow us',
  contact: 'Contact us',
  about: 'About us',
  team: 'Our team',
  shows: 'Shows',
  clients: 'Clients',
  skip: 'Skip to content',
  readMore: 'Read more',
  breadcrumb: 'Breadcrumb',
  pages: 'Pages',
};
export const labelKeys = Object.keys(englishLabels) as [
  keyof typeof englishLabels,
  ...(keyof typeof englishLabels)[],
];
export const labelsSchema = z.partialRecord(z.enum(labelKeys), z.string().trim().min(1).max(190));
export type Labels = typeof englishLabels;
export const localizationSchema = z.object({
  labels: labelsSchema,
  categories: z
    .record(z.string().trim().min(1).max(200), z.string().trim().min(1).max(190))
    .refine((values) => Object.keys(values).length <= 500, 'Enter no more than 500 category labels'),
});
export type Localization = z.infer<typeof localizationSchema>;

const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80);
const url = z
  .url({ protocol: /^https$/ })
  .refine((value) => {
    const address = URL.parse(value);
    return Boolean(address && !address.username && !address.password);
  })
  .max(1500);
const text = z.string().trim().min(1).max(180);
const sectionSchema = z.object({
  key: z.enum(sectionKeys),
  visible: z.boolean(),
  limit: z.number().int().min(1).max(40),
});
const item = z.object({ title: text, url, image: url.optional() });
const ad = z.object({ slot: z.enum(['home-top', 'article-top']), label: text, image: url, url });
const staticPage = z.object({
  slug,
  title: text,
  content: z.string().trim().max(25000),
  format: z.enum(['text', 'html']).optional(),
});
const link = z.object({
  label: text,
  href: z.union([
    url,
    z
      .string()
      .regex(/^\/(?!\/)[a-z0-9/_-]*$/i)
      .max(200),
  ]),
});

function distinct<K extends string>(key: K) {
  return (items: Record<K, string>[]) => new Set(items.map((item) => item[key])).size === items.length;
}

export const websiteSchema = z.object({
  name: text,
  logo: url.nullable(),
  primary: z.string().regex(/^#[0-9a-f]{6}$/i),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i),
  font: z.enum(['system', 'serif', 'sans']),
  sections: z.array(sectionSchema).max(6).refine(distinct('key')),
  popularLanguages: z
    .array(
      z
        .string()
        .max(16)
        .regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)
        .transform((code) => code.toLowerCase()),
    )
    .max(12)
    .optional(),
  navigation: z.array(link).max(20),
  footer: z.array(link).max(20),
  pages: z.array(staticPage).max(40).refine(distinct('slug')),
  videos: z.array(item).max(40),
  magazines: z.array(item).max(40),
  ads: z.array(ad).max(2).refine(distinct('slot')),
  sharing: z.boolean(),
});
export const overrideSchema = websiteSchema.partial();
export type Website = z.infer<typeof websiteSchema>;
export type WebsiteOverride = z.infer<typeof overrideSchema>;

export const defaultWebsite: Website = {
  name: 'Travel And Tour World',
  logo: null,
  primary: '#12253f',
  accent: '#cf2138',
  font: 'system',
  sections: [
    { key: 'featured', visible: true, limit: 3 },
    { key: 'latest', visible: true, limit: 12 },
    { key: 'categories', visible: true, limit: 8 },
    { key: 'interviews', visible: true, limit: 4 },
    { key: 'videos', visible: true, limit: 4 },
    { key: 'magazine', visible: true, limit: 3 },
  ],
  popularLanguages: [],
  navigation: [],
  footer: [],
  pages: [],
  videos: [],
  magazines: [],
  ads: [],
  sharing: true,
};
