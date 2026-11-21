import express from 'express';
import helmet from 'helmet';
import { rows } from '../../../packages/database/src/db';
import { Article, normalizeHost } from '../../../packages/shared/src/article';
import { linkTargets, rewriteLinks } from '../../../packages/shared/src/html';
import { articlePath, escape, jsonLd, links } from './seo';

type Domain = {
  id: number;
  origin: string;
  code: string;
  name: string;
  sitemap_enabled: number;
  rss_enabled: number;
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
app.use(async (request, response: PublicResponse, next) => {
  const host = normalizeHost(request.get('host') ?? '');
  const [domain] = await rows<Domain>(
    `SELECT d.id,d.origin,l.code,l.name,d.sitemap_enabled,d.rss_enabled
    FROM domains d JOIN languages l ON l.id=d.language_id WHERE d.hostname=? AND d.enabled=1`,
    [host],
  );
  if (!domain) {
    response.status(404).type('text').send('Unknown or disabled domain');
    return;
  }
  response.locals.domain = domain;
  next();
});

const source = `FROM article_translations t JOIN articles a ON a.id=t.article_id
  JOIN translation_jobs j ON j.id=t.job_id JOIN article_versions v ON v.article_id=t.article_id AND v.source_hash=j.source_hash
  WHERE t.domain_id=? AND t.state='published' AND a.status='publish'`;
const fields = 'SELECT t.*,a.published_at,v.payload ';
const style = `<style>
  *{box-sizing:border-box}body{margin:0;background:#f6f8fc;color:#142138;font:16px/1.65 system-ui,sans-serif}
  header{background:#101d35;color:white;padding:18px max(22px,calc((100vw - 960px)/2));font-weight:800;letter-spacing:.04em}
  header a{color:inherit;text-decoration:none}main{max-width:960px;margin:36px auto;padding:0 24px}h1{font-size:clamp(2rem,5vw,3.5rem);line-height:1.08;letter-spacing:-.04em}
  a{color:#164caf}img{max-width:100%;height:auto;border-radius:8px}.card,article{background:white;border:1px solid #dce5f1;border-radius:12px;padding:clamp(20px,4vw,45px);margin-bottom:14px}
  .card h2{margin:0}.card a{text-decoration:none}time{color:#526078}.demo{color:#81560d;font-weight:700}footer{max-width:960px;margin:40px auto;padding:0 24px;color:#526078}
</style>`;

const locale = (domain: Domain) =>
  domain.code.startsWith('fr')
    ? {
        latest: 'Dernières actualités',
        empty: 'Aucun article publié pour le moment.',
        demo: 'Contenu de démonstration',
        feed: 'Flux RSS',
      }
    : {
        latest: 'Latest news',
        empty: 'No articles have been published yet.',
        demo: 'Demonstration content',
        feed: 'RSS feed',
      };

function page(domain: Domain, title: string, main: string, head: string) {
  return `<!doctype html><html lang="${escape(domain.code)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>${head}${style}</head>
    <body><header><a href="/">TRAVEL AND TOUR WORLD</a></header><main>${main}</main>
    <footer>${domain.rss_enabled ? `<a href="/feed/">${locale(domain).feed}</a>` : ''}</footer></body></html>`;
}

app.get('/', async (_request, response: PublicResponse) => {
  const domain = response.locals.domain;
  const articles = await rows<Published>(fields + source + ' ORDER BY a.published_at DESC LIMIT 40', [
    domain.id,
  ]);
  const main =
    `<h1>${locale(domain).latest}</h1>` +
    (articles
      .map(
        (article) => `<section class="card">
    <h2><a href="${articlePath(article.slug)}">${escape(article.title)}</a></h2>
    <time datetime="${article.published_at.toISOString()}">${new Intl.DateTimeFormat(domain.code, { dateStyle: 'long', timeZone: 'UTC' }).format(article.published_at)}</time>
    ${article.mock ? `<div class="demo">${locale(domain).demo}</div>` : ''}</section>`,
      )
      .join('') || `<p>${locale(domain).empty}</p>`);
  response.send(page(domain, locale(domain).latest, main, links(domain.origin + '/', [])));
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
  const alternateTranslations = article.mock
    ? []
    : await rows<{ code: string; origin: string; slug: string }>(
        `
    SELECT l.code,d.origin,t.slug FROM article_translations t JOIN domains d ON d.id=t.domain_id JOIN languages l ON l.id=d.language_id
    WHERE t.article_id=? AND t.state='published' AND t.mock=0 AND d.enabled=1 ORDER BY (d.id=?) DESC,d.id`,
        [article.article_id, domain.id],
      );
  const alternatives = [
    ...new Map(
      alternateTranslations
        .reverse()
        .map((item) => [item.code, { code: item.code, url: item.origin + articlePath(item.slug) }]),
    ).values(),
  ];
  const { payload } = article;
  if (!article.mock)
    alternatives.push(
      { code: payload.language, url: payload.canonical },
      { code: 'x-default', url: payload.canonical },
    );
  const mapped = await rows<{ canonical: string; slug: string }>(
    `SELECT a.canonical,t.slug
    FROM article_translations t JOIN articles a ON a.id=t.article_id WHERE t.domain_id=? AND t.state='published' AND a.status='publish'
    AND (t.mock=0 OR ?=1) AND a.source_host=? AND BINARY a.canonical IN (
      SELECT BINARY value FROM JSON_TABLE(?, '$[*]' COLUMNS(value VARCHAR(1500) PATH '$')) link_targets
    )`,
    [
      domain.id,
      article.mock,
      payload.sourceHost,
      JSON.stringify(linkTargets(article.content, payload.canonical)),
    ],
  );
  const mapping = new Map(mapped.map((item) => [item.canonical.replace(/\/$/, ''), articlePath(item.slug)]));
  const image = payload.featuredImage
    ? `<img class="lead" src="${escape(payload.featuredImage)}" alt="${escape(payload.imageAlt)}" decoding="async">`
    : '';
  const main = `<article><h1>${escape(article.title)}</h1>${article.mock ? `<p class="demo">${locale(domain).demo}</p>` : ''}
    <p>${escape(payload.author)} · <time datetime="${article.published_at.toISOString()}">${new Intl.DateTimeFormat(domain.code, { dateStyle: 'long', timeZone: 'UTC' }).format(article.published_at)}</time></p>
    ${image}${rewriteLinks(article.content, payload.canonical, mapping)}</article>`;
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
  response.send(page(domain, article.seo_title, main, head));
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
  response
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${urls.join('')}</urlset>`,
    );
});

app.get('/feed', async (_request, response: PublicResponse) => {
  const domain = response.locals.domain;
  if (!domain.rss_enabled) {
    response.sendStatus(404);
    return;
  }
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
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Travel And Tour World</title><link>${escape(domain.origin)}</link><language>${escape(domain.code)}</language><description>${locale(domain).latest}</description>${items.join('')}</channel></rss>`,
    );
});

app.get('/robots.txt', (_request, response: PublicResponse) => {
  const domain = response.locals.domain;
  response
    .type('text')
    .send(
      `User-agent: *\nAllow: /\n${domain.sitemap_enabled ? 'Sitemap: ' + domain.origin + '/sitemap.xml\n' : ''}`,
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
  response.sendStatus(404);
}

app.get(/.*/, redirect);
app.use((error: Error, _request: express.Request, response: express.Response, next: express.NextFunction) => {
  console.error(JSON.stringify({ event: 'public_request_error', type: error.name }));
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(503).type('text').send('Service temporarily unavailable');
});
app.listen(Number(process.env.WEB_PORT ?? 3001), process.env.BIND_HOST ?? '127.0.0.1');
