import { createHash } from 'node:crypto';
import { z } from 'zod';

export function normalizeHost(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

const httpUrl = z.url({ protocol: /^https?$/ }).max(1500);
export const articleSchema = z.object({
  postId: z.coerce.string().regex(/^\d{1,20}$/),
  sourceHost: z.string().max(253).transform(normalizeHost),
  title: z.string().trim().min(1).max(500),
  content: z.string().max(500_000),
  excerpt: z.string().max(8000).default(''),
  featuredImage: z.union([httpUrl, z.literal('')]).default(''),
  imageAlt: z.string().max(500).default(''),
  author: z.string().max(200).default(''),
  categories: z.array(z.string().max(200)).max(100).default([]),
  tags: z.array(z.string().max(200)).max(100).default([]),
  slug: z.string().max(250),
  publishedAt: z.iso.datetime({ offset: true }),
  modifiedAt: z.iso.datetime({ offset: true }),
  status: z.enum(['publish', 'withdrawn']),
  canonical: httpUrl,
  seoTitle: z.string().max(500).default(''),
  seoDescription: z.string().max(8000).default(''),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
    .max(16)
    .default('en'),
  articleType: z.string().max(60).default('post'),
  siteId: z
    .string()
    .regex(/^[a-z0-9_-]{1,80}$/i)
    .optional(),
  categoryIds: z.array(z.number().int().positive()).max(100).optional(),
  imageMetadata: z
    .object({
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      mime: z.string().max(100).optional(),
    })
    .optional(),
});

export type Article = z.infer<typeof articleSchema>;
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function contentHash(article: Article) {
  const { modifiedAt: _modifiedAt, ...content } = article;
  void _modifiedAt;
  return sha256(
    JSON.stringify({
      ...content,
      categories: [...content.categories].sort(),
      tags: [...content.tags].sort(),
    }),
  );
}

export function localDay(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function localizedSlug(title: string, articleId: number) {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
  return `${Array.from(slug).slice(0, 155).join('').replace(/-$/, '') || 'article'}-${articleId}`;
}
