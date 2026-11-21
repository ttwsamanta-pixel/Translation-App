import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { get } from 'node:http';
import mysql from 'mysql2/promise';
import 'dotenv/config';

if (process.env.NODE_ENV === 'production')
  throw new Error('Use an isolated development database for this smoke test');
const api = 'http://127.0.0.1:' + (process.env.API_PORT ?? 3000);
const web = 'http://127.0.0.1:' + (process.env.WEB_PORT ?? 3001);
const host = process.env.PILOT_HOST;
const sourceHost = process.env.SOURCE_HOST;
const apiKey = process.env.WEBHOOK_API_KEY;
const secret = process.env.WEBHOOK_SECRET;
if (!host || !sourceHost || !apiKey || !secret) throw new Error('Set the pilot variables in .env');
const stamp = new Date().toISOString();
const postId = String(Date.now());
const body = JSON.stringify({
  postId,
  sourceHost,
  title: 'European tourism report',
  content:
    '<figure><img src="/photos/hero.jpg" alt="Stadium"></figure><p>Travel news from <a href="/europe">Europe</a>.</p>',
  featuredImage: 'https://' + sourceHost + '/photos/hero.jpg',
  excerpt: 'The latest travel report',
  slug: 'european-tourism-report',
  publishedAt: stamp,
  modifiedAt: stamp,
  canonical: 'https://' + sourceHost + '/european-tourism-report-' + postId,
  status: 'publish',
  language: 'en',
});
const requestId = randomUUID();
const post = (id, raw = body, expired = false) => {
  const timestamp = String(Math.floor(Date.now() / 1000) - (expired ? 360 : 0));
  const signature = createHmac('sha256', secret)
    .update(timestamp + '.' + id + '.' + raw)
    .digest('hex');
  return fetch(api + '/api/v1/webhooks/wordpress/article', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Timestamp': timestamp,
      'X-Request-Id': id,
      'X-Signature': signature,
    },
    body: raw,
  });
};

async function admin(path, options) {
  const response = await fetch(api + '/api/v1/' + path, options);
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}
async function publicPage(path, hostname = host) {
  return new Promise((resolve, reject) => {
    get(web + path, { headers: { Host: hostname } }, async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      } catch (error) {
        reject(error);
      }
    }).on('error', reject);
  });
}
assert.equal((await fetch(api + '/ready')).status, 200);
assert.equal((await publicPage('/', 'unknown.test')).status, 404);
assert.equal((await post(randomUUID(), body, true)).status, 401);
const invalidArticle = await post(
  randomUUID(),
  JSON.stringify({ ...JSON.parse(body), publishedAt: 'invalid date' }),
);
assert.equal(invalidArticle.status, 400);
assert.deepEqual((await invalidArticle.json()).message, ['publishedAt']);
const mismatchedSource = await post(
  randomUUID(),
  JSON.stringify({ ...JSON.parse(body), sourceHost: 'unexpected.example' }),
);
assert.equal(mismatchedSource.status, 400);
assert.equal((await mismatchedSource.json()).message, 'Source host does not match configuration');
const event = await post(requestId);
const first = await event.json();
assert.equal(event.status, 202, JSON.stringify(first));
assert.equal(first.created, 1, 'Run against a fresh, enabled one-domain seed');
assert.equal((await (await post(requestId)).json()).duplicate, true);
assert.equal((await (await post(randomUUID())).json()).unchanged, true);
assert.equal((await post(requestId, body + ' ')).status, 409);
assert.equal((await fetch(api + '/api/v1/overview')).status, 401);

const auth = await admin('auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
});
const options = { headers: { Authorization: 'Bearer ' + auth.token } };
async function awaitTranslation(articleId, state) {
  for (let attempt = 0; attempt < 35; attempt++) {
    const detail = await admin('articles/' + articleId, options);
    assert.equal(detail.jobs.length, 1);
    const translation = detail.translations.find((item) => item.state === state);
    if (translation) return { translation, job: detail.jobs[0] };
    assert.notEqual(detail.jobs[0].state, 'failed', JSON.stringify(detail.jobs[0]));
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('The worker did not reach ' + state);
}
const { translation: translated } = await awaitTranslation(first.articleId, 'published');
const publicPath = '/article/' + encodeURIComponent(translated.slug);
const page = await publicPage(publicPath);
assert.equal(page.status, 200);
const html = page.body;
assert.ok(html.includes('lang="fr-FR"'));
assert.ok(html.includes(process.env.PILOT_ORIGIN + publicPath));
assert.match(html, /<h1>.+<\/h1>/);
assert.equal([...html.matchAll(/<img\b[^>]*src="[^"]*\/photos\/hero\.jpg"/g)].length, 1);
const overview = await admin('overview', options);
assert.ok(overview.jobs.some((row) => row.state === 'published'));
assert.ok(overview.usage.some((row) => Number(row.requests) > 0));
for (const path of ['/sitemap.xml', '/news-sitemap.xml', '/feed/', '/robots.txt']) {
  const publicMetadata = await publicPage(path);
  assert.equal(publicMetadata.status, 200, path);
  const content = publicMetadata.body;
  if (path === '/robots.txt') assert.ok(content.includes(process.env.PILOT_ORIGIN + '/sitemap.xml'));
  else if (html.includes('noindex,nofollow'))
    assert.ok(!content.includes(publicPath), 'Mock output must remain out of feeds and sitemaps');
  else assert.ok(content.includes(publicPath), path);
}
const withdrawn = JSON.stringify({
  ...JSON.parse(body),
  modifiedAt: new Date(Date.now() + 1000).toISOString(),
  status: 'withdrawn',
});
assert.equal((await post(randomUUID(), withdrawn)).status, 202);
assert.equal((await publicPage(publicPath)).status, 404);
const domains = await admin('catalog/domains', options);
assert.equal(domains.items.length, 1);
const domain = domains.items[0];
const writeOptions = { method: 'PATCH', headers: { ...options.headers, 'Content-Type': 'application/json' } };
const patch = (path, body) => admin(path, { ...writeOptions, body: JSON.stringify(body) });
const saveDomain = (update) =>
  patch('domains/' + domain.id, {
    ...domain,
    enabled: Boolean(domain.enabled),
    sitemap_enabled: Boolean(domain.sitemap_enabled),
    rss_enabled: Boolean(domain.rss_enabled),
    manual_approval: Boolean(domain.manual_approval),
    ...update,
  });
const newPost = (suffix) =>
  JSON.stringify({
    ...JSON.parse(body),
    postId: postId + suffix,
    canonical: 'https://' + sourceHost + '/smoke-' + postId + suffix,
    content: '<p>Smoke test article ' + postId + suffix + '.</p>',
  });
try {
  await saveDomain({ daily_limit: 0 });
  assert.equal((await (await post(randomUUID(), newPost('1'))).json()).created, 0);
  await saveDomain({ enabled: false });
  assert.equal((await publicPage('/')).status, 404);
  assert.equal((await (await post(randomUUID(), newPost('2'))).json()).created, 0);
} finally {
  await saveDomain({});
}
if (process.env.ALLOW_MOCK_TRANSLATION === 'true' && !process.env.DEEPL_API_KEY) {
  const testDb = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    await testDb.execute(
      "INSERT IGNORE INTO translation_providers (name,adapter) VALUES ('Smoke primary','deepl')",
    );
  } finally {
    await testDb.end();
  }
  const providers = await admin('catalog/providers', options);
  const unavailable = providers.items.find((item) => item.name === 'Smoke primary');
  assert.ok(unavailable);
  await patch('providers/' + unavailable.id, { enabled: true, cost_inr_per_million: 0 });
  const groups = await admin('catalog/groups', options);
  const group = groups.items.find((item) => item.id === domain.group_id);
  assert.ok(group);
  const saveGroup = (update) =>
    patch('groups/' + group.id, { ...group, enabled: Boolean(group.enabled), ...update });
  try {
    await saveGroup({ provider_id: unavailable.id, fallback_provider_id: group.provider_id });
    await saveDomain({ manual_approval: true });
    const event = await (await post(randomUUID(), newPost('3'))).json();
    assert.equal(event.created, 1);
    const { translation, job } = await awaitTranslation(event.articleId, 'review');
    const path = '/article/' + encodeURIComponent(translation.slug);
    assert.equal((await publicPage(path)).status, 404);
    assert.equal((await patch('jobs/' + job.id, { action: 'approve' })).changed, true);
    assert.equal((await publicPage(path)).status, 200);
    assert.equal((await patch('jobs/' + job.id, { action: 'unpublish' })).changed, true);
    assert.equal((await publicPage(path)).status, 404);
    const report = await admin('overview', options);
    assert.ok(report.usage.some((row) => Number(row.fallbacks) > 0));
  } finally {
    await saveGroup({});
    await saveDomain({});
  }
}
console.log(
  'Smoke test passed: signed ingestion, replay handling, worker publishing, SSR, metadata, usage, withdrawal, quotas, disabled domains, fallback and approval.',
);
