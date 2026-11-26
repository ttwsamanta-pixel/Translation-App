import express from 'express';
import helmet from 'helmet';
import { resolve } from 'node:path';
import { rows } from '../../../packages/database/src/db';
import { websiteSettings } from '../../../packages/database/src/website';
import { Article, normalizeHost } from '../../../packages/shared/src/article';
import {
  firstImageMatches,
  linkTargets,
  rewriteLinks,
  sanitizeArticle,
} from '../../../packages/shared/src/html';
import { redis } from '../../../packages/shared/src/queue';
import { publicLabels } from './locale';
import { articlePath, escape, jsonLd, links } from './seo';
import {
  adSlot,
  authorPath,
  categoryLabel,
  categoryPath,
  editionHref,
  editionScript,
  pagePath,
  renderPage,
  tagPath,
  sourcePath,
  TemplateContext,
} from './template';

type Domain = {
  id: number;
  language_id: number;
  origin: string;
  code: string;
  name: string;
  sitemap_enabled: number;
  rss_enabled: number;
  site_generation: string | number;
  content_generation: string | number;
};
type Published = {
  article_id: number;
  slug: string;
  title: string;
  seo_title: string;
  seo_description: string;
  content: string;
  mock: number;
  updated_at: Date;
  published_at: Date;
  payload: Article;
};
type PublicResponse = express.Response<unknown, { domain: Domain }>;

const app = express();
const cache = process.env.REDIS_URL ? redis() : undefined;
cache?.on('error', (error) =>
  console.warn(JSON.stringify({ event: 'public_cache_error', type: error.name })),
);
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'https:', 'http:', 'data:'],
      },
    },
  }),
);
app.get('/liveness', (_request, response) => {
  response.json({ status: 'up' });
});
app.use('/assets/ttw', express.static(resolve('apps/web/public/ttw'), { index: false, maxAge: '1h' }));
app.get('/assets/editions.js', (_request, response) => {
  response.type('application/javascript').set('Cache-Control', 'public, max-age=3600').send(editionScript);
});
app.use(async (request, response: PublicResponse, next) => {
  const host = normalizeHost(request.get('host') ?? '');
  const [domain] = await rows<Domain>(
    `SELECT d.id,d.origin,d.language_id,l.code,l.name,d.sitemap_enabled,d.rss_enabled,
    COALESCE(s.generation,0) site_generation,COALESCE(c.generation,0) content_generation
    FROM domains d JOIN languages l ON l.id=d.language_id
    LEFT JOIN public_cache_generations s ON s.domain_id=0 LEFT JOIN public_cache_generations c ON c.domain_id=d.id
    WHERE d.hostname=? AND d.enabled=1`,
    [host],
  );
  if (!domain) {
    response.status(404).type('text').send('Unknown or disabled domain');
    return;
  }
  response.locals.domain = domain;
  next();
});

const storyTables = `FROM article_translations t JOIN articles a ON a.id=t.article_id
  JOIN translation_jobs j ON j.id=t.job_id JOIN article_versions v ON v.article_id=t.article_id AND v.source_hash=j.source_hash`;
const published = "WHERE t.domain_id=? AND t.state='published' AND a.status='publish'";
const source = storyTables + ' ' + published + " AND a.content_type='post'";
const pageSource = storyTables + ' ' + published + " AND a.content_type='page'";
const sourceHost = normalizeHost(process.env.SOURCE_HOST || 'travelandtourworld.com');
const fields = 'SELECT t.*,a.published_at,v.payload ';
type Card = Pick<Published, 'slug' | 'title' | 'published_at' | 'mock'> & {
  image: string;
  category: string;
  excerpt: string;
};
const cardFields = `SELECT t.slug,t.title,t.mock,t.excerpt,a.published_at,a.category,
  JSON_UNQUOTE(JSON_EXTRACT(v.payload,'$.featuredImage')) image `;
const categoryTable = "JSON_TABLE(v.payload,'$.categories[*]' COLUMNS(name VARCHAR(200) PATH '$'))";
const categoryMatch = `? IN (SELECT name FROM ${categoryTable} entries)`;
const tagMatch = "JSON_CONTAINS(JSON_EXTRACT(v.payload,'$.tags'), JSON_QUOTE(?))";
const interviewMatch = `(JSON_UNQUOTE(JSON_EXTRACT(v.payload,'$.articleType'))='interview' OR ${categoryMatch})`;

async function context(domain: Domain, article?: Published): Promise<TemplateContext> {
  const [settings, editions, pages] = await Promise.all([
    websiteSettings(domain),
    rows<{ id: number; name: string; code: string; origin: string; slug: string | null }>(
      `SELECT d.id,l.name,l.code,d.origin,t.slug FROM domains d JOIN languages l ON l.id=d.language_id
      LEFT JOIN article_translations t ON t.domain_id=d.id AND t.article_id=?
        AND t.state='published' AND (t.mock=0 OR t.domain_id=?)
      WHERE d.enabled=1
      ORDER BY (d.id=?) DESC,l.name,d.id`,
      [article?.article_id ?? null, domain.id, domain.id],
    ),
    rows<NonNullable<TemplateContext['pages']>[number]>(
      `SELECT t.slug,t.title,t.mock,a.canonical ${pageSource} ORDER BY t.title,t.id`,
      [domain.id],
    ),
  ]);
  return {
    code: domain.code,
    rss: Boolean(domain.rss_enabled),
    design: settings.design,
    labels: publicLabels(domain.code, settings.translations?.labels),
    categoryLabels: settings.translations?.categories,
    sourceHost,
    pages,
    editions: editions.map((item) => ({
      name: item.name,
      code: item.code,
      url: item.slug
        ? item.origin +
          (article?.payload.articleType === 'page' ? pagePath(item.slug) : articlePath(item.slug))
        : article
          ? null
          : item.origin + '/',
      current: item.id === domain.id,
    })),
  };
}

async function localizedContent(
  domain: Domain,
  site: TemplateContext,
  html: string,
  base: string,
  mock: number,
) {
  const targets = linkTargets(html, base);
  const mapped = targets.length
    ? await rows<{ canonical: string; slug: string; content_type: 'post' | 'page' }>(
        `SELECT a.canonical,t.slug,a.content_type FROM article_translations t JOIN articles a ON a.id=t.article_id
     WHERE t.domain_id=? AND t.state='published' AND a.status='publish' AND (t.mock=0 OR ?=1) AND a.source_host=?
       AND BINARY a.canonical IN (SELECT BINARY value FROM JSON_TABLE(?, '$[*]' COLUMNS(value VARCHAR(1500) PATH '$')) targets)`,
        [domain.id, mock, normalizeHost(new URL(base).hostname), JSON.stringify(targets)],
      )
    : [];
  const destinations = new Map(
    mapped.map((item) => [
      sourcePath(new URL(item.canonical).pathname),
      item.content_type === 'page' ? pagePath(item.slug) : articlePath(item.slug),
    ]),
  );
  const host = normalizeHost(new URL(base).hostname);
  return rewriteLinks(html, base, new Map(), (href) => {
    const url = new URL(href);
    const localized = normalizeHost(url.hostname) === host && destinations.get(sourcePath(url.pathname));
    return localized ? localized + url.search + url.hash : editionHref(site, href);
  });
}

function editionAlternates(site: TemplateContext) {
  return [
    ...new Map(
      [...site.editions].reverse().flatMap(({ code, url }) => (url ? [[code, { code, url }] as const] : [])),
    ).values(),
  ];
}

function articleCards(items: Card[], site: TemplateContext, featured = false) {
  if (!items.length) return `<p>${escape(site.labels.empty)}</p>`;
  const date = new Intl.DateTimeFormat(site.code, { dateStyle: 'long', timeZone: 'UTC' });
  return `<div class="grid${featured ? ' featured' : ''}">${items
    .map((item) => {
      const href = articlePath(item.slug);
      return `<section class="card">${item.image ? `<a href="${href}" tabindex="-1" aria-hidden="true"><img src="${escape(item.image)}" alt="" loading="lazy"></a>` : ''}
      <div><h3><a href="${href}">${escape(item.title)}</a></h3><time datetime="${item.published_at.toISOString()}">${date.format(item.published_at)}</time>
      ${item.mock ? `<p class="demo">${escape(site.labels.demo)}</p>` : ''}</div></section>`;
    })
    .join('')}</div>`;
}

function editionMedia(items: TemplateContext['design']['videos'], site: TemplateContext) {
  return items.flatMap((item) => {
    const url = editionHref(site, item.url);
    return url ? [{ ...item, url }] : [];
  });
}

function mediaCards(sourceItems: TemplateContext['design']['videos'], site: TemplateContext) {
  const items = editionMedia(sourceItems, site);
  return items.length
    ? `<div class="grid">${items
        .map(
          (item) =>
            `<section class="card"><a href="${escape(item.url)}">${item.image ? `<img src="${escape(item.image)}" alt="" loading="lazy">` : ''}
    <div><h3>${escape(item.title)}</h3></div></a></section>`,
        )
        .join('')}</div>`
    : `<p>${escape(site.labels.empty)}</p>`;
}

type Lead = { title: string; url: string; image?: string; excerpt?: string; published?: Date };

function leadTime(site: TemplateContext, date?: Date) {
  if (!date) return '';
  return `<time datetime="${date.toISOString()}">${new Intl.DateTimeFormat(site.code, { dateStyle: 'medium', timeZone: 'UTC' }).format(date)}</time>`;
}

function archiveCards(items: Card[], site: TemplateContext) {
  if (!items.length) return `<p>${escape(site.labels.empty)}</p>`;
  return `<div class="category-news-list">${items
    .map((item) => {
      const url = articlePath(item.slug);
      return `<article class="category-news-card">
      ${item.image ? `<a class="category-news-card__media" href="${url}" tabindex="-1" aria-hidden="true"><img class="category-news-card__image" src="${escape(item.image)}" alt="" loading="lazy"></a>` : '<div class="category-news-card__media category-news-card__placeholder" aria-hidden="true"></div>'}
      <div class="category-news-card__body"><div class="category-news-card__meta">${leadTime(site, item.published_at)}</div>
      <h2 class="category-news-card__title"><a href="${url}">${escape(item.title)}</a></h2>
      ${item.excerpt ? `<p class="category-news-card__excerpt">${escape(item.excerpt.slice(0, 240))}</p>` : ''}
      ${item.mock ? `<p class="demo">${escape(site.labels.demo)}</p>` : ''}
      <a class="category-news-card__read-more" href="${url}">${escape(site.labels.readMore)} <span aria-hidden="true">→</span></a></div></article>`;
    })
    .join('')}</div>`;
}

function breadcrumbs(site: TemplateContext, current: string, section?: { href: string; label: string }) {
  return `<nav class="ttw-breadcrumb" aria-label="${escape(site.labels.breadcrumb)}"><a href="/">${escape(site.labels.home)}</a>
    <span aria-hidden="true">/</span>${section ? `<a href="${escape(section.href)}">${escape(section.label)}</a><span aria-hidden="true">/</span>` : ''}
    <span aria-current="page">${escape(current)}</span></nav>`;
}

function leadCards(items: Lead[], site: TemplateContext) {
  return `<div class="news-side-list">${items
    .map(
      (item) => `<a class="news-side-card" href="${escape(item.url)}">
    <div class="news-side-card__media">${item.image ? `<img src="${escape(item.image)}" alt="" loading="lazy" width="110" height="80">` : ''}</div>
    <div class="news-side-card__body"><h3 class="news-side-card__title">${escape(item.title)}</h3>
    <div class="news-side-card__meta">${leadTime(site, item.published)}</div></div></a>`,
    )
    .join('')}</div>`;
}

function leadCarousel(items: Lead[], site: TemplateContext) {
  if (!items.length) return '';
  const buttons =
    items.length > 1
      ? `<div class="ttw-carousel-controls">
    <button type="button" data-step="-1" aria-label="${escape(site.labels.previous)}">‹</button>
    <button type="button" data-step="1" aria-label="${escape(site.labels.next)}">›</button></div>`
      : '';
  return `<div class="news-carousel" data-ttw-carousel>${items
    .map(
      (
        item,
        index,
      ) => `<div class="news-carousel__slide${index === 0 ? ' is-active' : ''}"${index === 0 ? '' : ' hidden'}>
    <div class="news-carousel__placeholder" aria-hidden="true"></div>
    ${item.image ? `<img src="${escape(item.image)}" alt="" ${index === 0 ? 'fetchpriority="high"' : 'loading="lazy"'}>` : ''}
    <div class="news-carousel__overlay"><h3 class="news-carousel__title"><a href="${escape(item.url)}">${escape(item.title)}</a></h3>
    ${item.excerpt ? `<p class="news-carousel__excerpt">${escape(item.excerpt.slice(0, 220))}</p>` : ''}
    <div class="news-carousel__meta">${leadTime(site, item.published)}</div></div></div>`,
    )
    .join('')}${buttons}</div>`;
}

function newsHero(items: Card[], site: TemplateContext, featured: number) {
  if (!items.length) return `<p>${escape(site.labels.empty)}</p>`;
  const leads = items.map((item) => ({
    title: item.title,
    url: articlePath(item.slug),
    image: item.image,
    excerpt: item.excerpt,
    published: item.published_at,
  }));
  const heroCount = Math.min(featured || 1, Math.max(1, leads.length - 1));
  return `<div class="latest-news__grid${leads.length > 1 ? '' : ' ttw-hero-only'}">
    ${leadCarousel(leads.slice(0, heroCount), site)}${leads.length > 1 ? leadCards(leads.slice(heroCount, heroCount + 5), site) : ''}</div>`;
}

function magazineSidebar(site: TemplateContext) {
  const [issue] = editionMedia(site.design.magazines, site);
  if (!issue) return '';
  return `<aside class="ttw-sidebar"><section class="ttw-sidebar-box"><h2><a href="/magazine">${escape(site.labels.magazine)}</a></h2>
    <a href="${escape(issue.url)}">${issue.image ? `<img src="${escape(issue.image)}" alt="" loading="lazy">` : ''}<h3>${escape(issue.title)}</h3></a></section></aside>`;
}

app.get('/', async (_request, response: PublicResponse) => {
  const domain = response.locals.domain;
  const cacheKey = `ttw:public:home:ttw4-pages:${domain.id}:${domain.site_generation}:${domain.content_generation}`;
  if (cache?.status === 'ready') {
    const saved = await cache.get(cacheKey).catch(() => null);
    if (saved) {
      response.send(saved);
      return;
    }
  }
  const site = await context(domain);
  const sections = site.design.sections.filter((section) => section.visible);
  const [latest, categories, interviews] = await Promise.all([
    sections.some(({ key }) => key === 'featured' || key === 'latest')
      ? rows<Card>(cardFields + source + ' ORDER BY a.published_at DESC,t.id DESC LIMIT 80', [domain.id])
      : [],
    sections.some(({ key }) => key === 'categories')
      ? rows<{ name: string }>(
          `SELECT c.name ${storyTables} CROSS JOIN ${categoryTable} c
        ${published} AND a.content_type='post' AND c.name<>'' GROUP BY c.name ORDER BY COUNT(*) DESC,c.name LIMIT 40`,
          [domain.id],
        )
      : [],
    sections.some(({ key }) => key === 'interviews')
      ? rows<Card>(
          cardFields + source + ' AND ' + interviewMatch + ' ORDER BY a.published_at DESC,t.id DESC LIMIT 40',
          [domain.id, 'Interviews'],
        )
      : [],
  ]);
  const blocks = sections.map(({ key, limit }) => {
    if (key === 'featured' && sections.some((item) => item.key === 'latest')) return '';
    if (key === 'latest') {
      const featured = sections.find((item) => item.key === 'featured')?.limit ?? 1;
      return `<section id="section-latest" class="home-section latest-news"><div class="latest-news__box">
        <h1 class="section-title"><a href="/news">${escape(site.labels.latest)}</a></h1>
        ${newsHero(latest.slice(0, limit), site, featured)}</div></section>`;
    }
    const body = {
      featured: () => articleCards(latest.slice(0, limit), site, true),
      categories: () =>
        `<div class="taxonomy">${categories
          .slice(0, limit)
          .map(({ name }) => `<a href="${categoryPath(name)}">${escape(categoryLabel(site, name))}</a>`)
          .join('')}</div>`,
      interviews: () => articleCards(interviews.slice(0, limit), site),
      videos: () => {
        const videos = editionMedia(site.design.videos, site).slice(0, 7);
        if (!videos.length) return '';
        const banners = Math.min(3, Math.max(1, videos.length - 4));
        return `<div class="ttw-video-grid">${leadCarousel(videos.slice(0, banners), site)}
          ${leadCards(videos.slice(banners, banners + Math.min(limit, 4)), site)}</div>`;
      },
      magazine: () => mediaCards(site.design.magazines.slice(0, limit), site),
    }[key]();
    if (!body || (key === 'magazine' && !site.design.magazines.length)) return '';
    return `<section class="ttw-block" id="section-${key}"><h2 class="ttw-section-title">${escape(site.labels[key])}</h2>${body}</section>`;
  });
  const availableEditions = editionAlternates(site);
  const html = renderPage(
    site,
    site.design.name,
    `${sections.some((section) => section.key === 'latest') ? '' : `<h1>${escape(site.design.name)}</h1>`}
      ${adSlot(site, 'home-top')}<div${site.design.magazines.length ? ' class="ttw-home-columns"' : ''}><div>${blocks.join('')}</div>${magazineSidebar(site)}</div>`,
    links(domain.origin + '/', availableEditions),
    { kind: 'home', path: '/' },
  );
  if (cache?.status === 'ready') void cache.set(cacheKey, html, 'EX', 90).catch(() => undefined);
  response.send(html);
});

app.get(
  ['/news', '/search', '/category/:name', '/author/:name', '/tag/:name', '/interviews'],
  async (request, response: PublicResponse) => {
    const domain = response.locals.domain;
    const site = await context(domain);
    const search = request.path === '/search';
    const category = request.path.startsWith('/category/');
    const author = request.path.startsWith('/author/');
    const tag = request.path.startsWith('/tag/');
    const interviews = request.path === '/interviews';
    const query = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 120) : '';
    const name = String(request.params.name ?? '')
      .trim()
      .slice(0, 200);
    const pageNumber = Math.max(1, Math.min(1000, Math.trunc(Number(request.query.page)) || 1));
    const condition = search
      ? " AND (t.title LIKE ? ESCAPE '!' OR t.excerpt LIKE ? ESCAPE '!')"
      : category
        ? ' AND ' + categoryMatch
        : author
          ? " AND JSON_UNQUOTE(JSON_EXTRACT(v.payload,'$.author'))=?"
          : tag
            ? ' AND ' + tagMatch
            : interviews
              ? ' AND ' + interviewMatch
              : '';
    const pattern = '%' + query.replace(/[!%_]/g, '!$&') + '%';
    const args = search
      ? [pattern, pattern]
      : category || author || tag
        ? [name]
        : interviews
          ? ['Interviews']
          : [];
    const items =
      search && !query
        ? []
        : await rows<Card>(
            cardFields + source + condition + ' ORDER BY a.published_at DESC,t.id DESC LIMIT 25 OFFSET ?',
            [domain.id, ...args, (pageNumber - 1) * 24],
          );
    const path = category
      ? categoryPath(name)
      : author
        ? authorPath(name)
        : tag
          ? tagPath(name)
          : request.path;
    const pagePath = (page: number) =>
      path +
      (search ? '?q=' + encodeURIComponent(query) + '&page=' + page : page === 1 ? '' : '?page=' + page);
    const title = search
      ? site.labels.search
      : category
        ? categoryLabel(site, name)
        : author || tag
          ? name
          : interviews
            ? site.labels.interviews
            : site.labels.latest;
    const main = `${breadcrumbs(site, title)}<h1 class="heading">${escape(title)}</h1>
    ${
      search
        ? `<form class="ttw-search-form" action="/search" role="search">
      <input name="q" type="search" maxlength="120" value="${escape(query)}" aria-label="${escape(site.labels.search)}" required>
      <button class="ttw-action">${escape(site.labels.search)}</button></form>`
        : ''
    }
    ${archiveCards(items.slice(0, 24), site)}
    <div class="pager">${pageNumber > 1 ? `<a rel="prev" href="${escape(pagePath(pageNumber - 1))}">${escape(site.labels.previous)}</a>` : ''}
    ${items.length > 24 && pageNumber < 1000 ? `<a rel="next" href="${escape(pagePath(pageNumber + 1))}">${escape(site.labels.next)}</a>` : ''}</div>`;
    if (!items.length && (category || author || tag)) response.status(404);
    response.send(
      renderPage(
        site,
        title,
        main,
        links(domain.origin + pagePath(pageNumber), []) +
          (search || response.statusCode === 404 ? '<meta name="robots" content="noindex,follow">' : ''),
        { kind: 'archive', path },
      ),
    );
  },
);

app.get('/categories', async (_request, response: PublicResponse) => {
  const domain = response.locals.domain;
  const [site, categories] = await Promise.all([
    context(domain),
    rows<{ name: string }>(
      `SELECT DISTINCT c.name ${storyTables} CROSS JOIN ${categoryTable} c
      ${published} AND a.content_type='post' AND c.name<>'' ORDER BY c.name LIMIT 1000`,
      [domain.id],
    ),
  ]);
  const body = categories.length
    ? `<div class="taxonomy">${categories
        .map(({ name }) => `<a href="${categoryPath(name)}">${escape(categoryLabel(site, name))}</a>`)
        .join('')}</div>`
    : `<p>${escape(site.labels.empty)}</p>`;
  response.send(
    renderPage(
      site,
      site.labels.categories,
      `<h1 class="heading">${escape(site.labels.categories)}</h1>${body}`,
      links(domain.origin + '/categories', []),
      { kind: 'archive', path: '/categories' },
    ),
  );
});

async function editionPage(request: express.Request, response: PublicResponse) {
  const domain = response.locals.domain;
  let site = await context(domain);
  const path = sourcePath(request.path);
  const page = site.design.pages.find(
    (item) => item.slug === request.params.slug || path === '/' + item.slug,
  );
  const videos = path === '/videos';
  const magazine = ['/magazine', '/magazines', '/magazine-archive'].includes(path);
  const available = site.pages?.find(
    (item) =>
      path === pagePath(item.slug) ||
      request.params.slug === item.slug ||
      sourcePath(new URL(item.canonical).pathname) === path,
  );
  if (
    !page &&
    available &&
    ((!videos && !magazine) || !(videos ? site.design.videos.length : site.design.magazines.length))
  ) {
    const [translated] = await rows<Published>(fields + pageSource + ' AND t.slug=? LIMIT 1', [
      domain.id,
      available.slug,
    ]);
    if (translated) {
      site = await context(domain, translated);
      const local = pagePath(translated.slug);
      const body = await localizedContent(
        domain,
        site,
        translated.content,
        translated.payload.canonical,
        translated.mock,
      );
      response.send(
        renderPage(
          site,
          translated.seo_title,
          `<article class="default-page-content">${breadcrumbs(site, translated.title)}
          <header class="default-page-content__header"><h1>${escape(translated.title)}</h1></header>
          <div class="default-page-content__body">${body}</div></article>`,
          links(domain.origin + local, translated.mock ? [] : editionAlternates(site)) +
            `<meta name="description" content="${escape(translated.seo_description)}">` +
            (translated.mock ? '<meta name="robots" content="noindex,nofollow">' : ''),
          { kind: 'page', path: local },
        ),
      );
      return;
    }
  }
  if (!videos && !magazine && !page) return redirect(request, response);
  const title = page?.title ?? (videos ? site.labels.videos : site.labels.magazine);
  const content = page
    ? `<div class="default-page-content__body${page.format === 'html' ? '' : ' static'}">${
        page.format === 'html'
          ? await localizedContent(
              domain,
              site,
              sanitizeArticle(page.content),
              'https://' + sourceHost + '/' + page.slug + '/',
              0,
            )
          : escape(page.content)
      }</div>`
    : mediaCards(videos ? site.design.videos : site.design.magazines, site);
  response.send(
    renderPage(
      site,
      title,
      `<article class="default-page-content">${breadcrumbs(site, title)}<header class="default-page-content__header">
        <h1>${escape(title)}</h1></header>${content}</article>`,
      links(domain.origin + (page ? '/page/' + page.slug : magazine ? '/magazine' : '/videos'), []),
      { kind: 'page', path: page ? '/' + page.slug : magazine ? '/magazine' : '/videos' },
    ),
  );
}
app.get(['/videos', '/magazine', '/magazines', '/magazine-archive', '/page/:slug'], editionPage);

app.get('/pages', async (_request, response: PublicResponse) => {
  const domain = response.locals.domain;
  const site = await context(domain);
  const pages = new Map([...site.design.pages, ...(site.pages ?? [])].map((page) => [page.slug, page.title]));
  const body = [...pages]
    .map(([slug, title]) => `<li><a href="${pagePath(slug)}">${escape(title)}</a></li>`)
    .join('');
  response.send(
    renderPage(
      site,
      site.labels.pages,
      `<article class="default-page-content">
    <header class="default-page-content__header"><h1>${escape(site.labels.pages)}</h1></header>
    ${body ? `<ul class="taxonomy">${body}</ul>` : `<p>${escape(site.labels.empty)}</p>`}</article>`,
      links(domain.origin + '/pages', []),
      { kind: 'page', path: '/pages' },
    ),
  );
});

app.get('/article/:slug', async (request, response: PublicResponse) => {
  const domain = response.locals.domain;
  const [article] = await rows<Published>(fields + source + ' AND t.slug=? LIMIT 1', [
    domain.id,
    request.params.slug,
  ]);
  if (!article) {
    await redirect(request, response);
    return;
  }
  const canonical = domain.origin + articlePath(article.slug);
  const site = await context(domain, article);
  const alternatives = article.mock ? [] : editionAlternates(site);
  const { payload } = article;
  if (!article.mock)
    alternatives.push(
      { code: payload.language, url: payload.canonical },
      { code: 'x-default', url: payload.canonical },
    );
  const body = await localizedContent(domain, site, article.content, payload.canonical, article.mock);
  const image =
    payload.featuredImage && !firstImageMatches(article.content, payload.featuredImage, payload.canonical)
      ? `<img class="lead" src="${escape(payload.featuredImage)}" alt="${escape(payload.imageAlt)}" decoding="async">`
      : '';
  const sharing =
    site.design.sharing && !article.mock
      ? `<div class="share"><strong>${escape(site.labels.share)}</strong>
    <a rel="noopener noreferrer" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(canonical)}">Facebook</a>
    <a rel="noopener noreferrer" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(canonical)}">LinkedIn</a>
    <a rel="noopener noreferrer" href="https://x.com/intent/post?url=${encodeURIComponent(canonical)}">X</a></div>`
      : '';
  const related = payload.categories[0]
    ? await rows<Card>(
        cardFields +
          source +
          ' AND t.article_id<>? AND t.mock=0 AND ' +
          categoryMatch +
          ' ORDER BY a.published_at DESC LIMIT 3',
        [domain.id, article.article_id, payload.categories[0]],
      )
    : [];
  const sidebar = magazineSidebar(site);
  const main = `${adSlot(site, 'article-top')}<div${sidebar ? ' class="ttw-article-columns"' : ''}><article class="story">
    ${breadcrumbs(site, article.title, { href: '/news', label: site.labels.news })}<header class="single-news-header">
    <div class="taxonomy">${payload.categories.map((name) => `<a href="${categoryPath(name)}">${escape(categoryLabel(site, name))}</a>`).join('')}</div>
    <h1>${escape(article.title)}</h1>${article.mock ? `<p class="demo">${escape(site.labels.demo)}</p>` : ''}
    <p class="meta">${payload.author ? `<a href="${authorPath(payload.author)}">${escape(payload.author)}</a> · ` : ''}
    <time datetime="${article.published_at.toISOString()}">${new Intl.DateTimeFormat(domain.code, { dateStyle: 'long', timeZone: 'UTC' }).format(article.published_at)}</time></p></header>
    ${image}<div class="single-news-content ttw-story-body">${body}</div>
    ${payload.tags.length ? `<div class="taxonomy">${payload.tags.map((name) => `<a href="${tagPath(name)}">${escape(name)}</a>`).join('')}</div>` : ''}
    ${sharing}</article>${sidebar}</div>
    ${related.length ? `<section class="block"><h2 class="heading">${escape(site.labels.related)}</h2>${articleCards(related, site)}</section>` : ''}`;
  const head =
    links(canonical, alternatives) +
    `<meta name="description" content="${escape(article.seo_description)}">
    ${article.mock ? '<meta name="robots" content="noindex,nofollow">' : ''}
    <meta property="og:type" content="article"><meta property="og:title" content="${escape(article.seo_title)}">
    <meta property="og:description" content="${escape(article.seo_description)}"><meta property="og:url" content="${escape(canonical)}">
    ${payload.featuredImage ? `<meta property="og:image" content="${escape(payload.featuredImage)}">` : ''}
    <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(article.seo_title)}">
    ${
      article.mock
        ? ''
        : `<script type="application/ld+json">${jsonLd({
            '@context': 'https://schema.org',
            '@type': 'NewsArticle',
            mainEntityOfPage: canonical,
            headline: article.title,
            description: article.seo_description,
            inLanguage: domain.code,
            image: payload.featuredImage || undefined,
            datePublished: article.published_at.toISOString(),
            dateModified: article.updated_at.toISOString(),
            author: { '@type': 'Person', name: payload.author || 'Travel And Tour World' },
          })}</script>`
    }`;
  response.send(renderPage(site, article.seo_title, main, head, { kind: 'article', path: '/news' }));
});

app.get(['/sitemap.xml', '/news-sitemap.xml'], async (request, response: PublicResponse) => {
  const domain = response.locals.domain;
  if (!domain.sitemap_enabled) {
    response.sendStatus(404);
    return;
  }
  const news = request.path === '/news-sitemap.xml';
  const records = await rows<Published>(
    `SELECT t.slug,t.title,t.updated_at,a.published_at ${source}
    AND t.mock=0 ${news ? 'AND a.published_at >= UTC_TIMESTAMP() - INTERVAL 2 DAY' : ''}
    ORDER BY a.published_at DESC LIMIT ${news ? 1000 : 50000}`,
    [domain.id],
  );
  const urls = records.map(
    (
      article,
    ) => `<url><loc>${escape(domain.origin + articlePath(article.slug))}</loc><lastmod>${article.updated_at.toISOString()}</lastmod>
    ${news ? `<news:news><news:publication><news:name>Travel And Tour World</news:name><news:language>${escape(domain.code.split('-')[0])}</news:language></news:publication><news:publication_date>${article.published_at.toISOString()}</news:publication_date><news:title>${escape(article.title)}</news:title></news:news>` : ''}</url>`,
  );
  if (!news) {
    const site = await context(domain);
    const pages = [
      '/',
      '/news',
      '/categories',
      '/interviews',
      '/videos',
      '/magazine',
      '/pages',
      ...site.design.pages.map((page) => pagePath(page.slug)),
      ...(site.pages?.filter((page) => !page.mock).map((page) => pagePath(page.slug)) ?? []),
    ];
    urls.unshift(...pages.map((path) => `<url><loc>${escape(domain.origin + path)}</loc></url>`));
    urls.length = Math.min(urls.length, 50000);
  }
  response
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${urls.join('')}</urlset>`,
    );
});

app.get(['/feed', '/rss.xml'], async (_request, response: PublicResponse) => {
  const domain = response.locals.domain;
  if (!domain.rss_enabled) {
    response.sendStatus(404);
    return;
  }
  const { design, translations } = await websiteSettings(domain);
  const labels = publicLabels(domain.code, translations?.labels);
  const records = await rows<Published>(
    fields + source + ' AND t.mock=0 ORDER BY a.published_at DESC LIMIT 30',
    [domain.id],
  );
  const items = records.map((article) => {
    const url = escape(domain.origin + articlePath(article.slug));
    return `<item><title>${escape(article.title)}</title><link>${url}</link><guid>${url}</guid><description>${escape(article.seo_description)}</description><pubDate>${article.published_at.toUTCString()}</pubDate></item>`;
  });
  response
    .type('application/rss+xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escape(design.name)}</title><link>${escape(domain.origin)}</link><language>${escape(domain.code)}</language><description>${escape(labels.latest)}</description>${items.join('')}</channel></rss>`,
    );
});

app.get('/robots.txt', (_request, response: PublicResponse) => {
  const domain = response.locals.domain;
  response
    .type('text')
    .send(
      `User-agent: *\nAllow: /\n${domain.sitemap_enabled ? 'Sitemap: ' + domain.origin + '/sitemap.xml\nSitemap: ' + domain.origin + '/news-sitemap.xml\n' : ''}`,
    );
});

async function redirect(request: express.Request, response: PublicResponse) {
  const [mapping] = await rows<{ new_path: string }>(
    'SELECT new_path FROM redirects WHERE domain_id=? AND old_path=?',
    [response.locals.domain.id, request.path],
  );
  const target = mapping?.new_path;
  if (target && /^\/(?![/\\])[^\\\r\n]*$/.test(target) && target !== request.path) {
    response.redirect(301, target);
    return;
  }
  const site = await context(response.locals.domain);
  response
    .status(404)
    .send(
      renderPage(
        site,
        site.labels.notFound,
        `<h1>${escape(site.labels.notFound)}</h1>`,
        '<meta name="robots" content="noindex">',
      ),
    );
}

app.get(/.*/, editionPage);
app.use((error: Error, _request: express.Request, response: express.Response, next: express.NextFunction) => {
  console.error(JSON.stringify({ event: 'public_request_error', type: error.name }));
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(503).type('text').send('Service temporarily unavailable');
});
app.listen(Number(process.env.WEB_PORT ?? 3001), process.env.BIND_HOST ?? '127.0.0.1');
