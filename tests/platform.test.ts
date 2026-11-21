import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  articleSchema,
  contentHash,
  localDay,
  localizedSlug,
  normalizeHost,
} from '../packages/shared/src/article';
import { signWebhook, verifyWebhook, passwordHash, validPassword } from '../packages/shared/src/auth';
import { firstImageMatches, htmlSegments, rewriteLinks } from '../packages/shared/src/html';
import { publicLabels } from '../apps/web/src/locale';
import { articlePath, jsonLd, links } from '../apps/web/src/seo';
import { providers } from '../packages/providers/src';

test('reuses the first article image when it matches the featured image', () => {
  const source = 'https://wordpress.example/news/story';
  const featured = 'https://wordpress.example/photos/hero.jpg';
  assert.ok(firstImageMatches('<figure><img src="/photos/hero.jpg"></figure>', featured, source));
  assert.ok(
    !firstImageMatches('<img src="/photos/other.jpg"><img src="/photos/hero.jpg">', featured, source),
  );
  assert.ok(!firstImageMatches('<p>Article without an image</p>', featured, source));
});

test('uses Armenian page labels for Armenian domains and keeps a fallback for other locales', () => {
  assert.equal(publicLabels('hy-AM').latest, 'Վերջին նորությունները');
  assert.equal(publicLabels('hy').feed, 'RSS հոսք');
  assert.equal(publicLabels('fr-FR').feed, 'Flux RSS');
  assert.equal(publicLabels('en').latest, 'Latest news');
});

test('Google Cloud translates through v2 with a header key and maps Chinese script locales', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://translation.googleapis.com/language/translate/v2');
    assert.equal(new Headers(options.headers).get('x-goog-api-key'), 'google-test');
    assert.deepEqual(JSON.parse(String(options.body)), {
      q: ['Hello'],
      source: 'en',
      target: 'zh-TW',
      format: 'text',
    });
    return Response.json({ data: { translations: [{ translatedText: '你好' }] } });
  });
  assert.deepEqual(
    await providers.google_cloud.translate(
      { text: ['Hello'], source: 'en-US', target: 'zh-Hant' },
      'google-test',
    ),
    ['你好'],
  );
});

test('Gemini requests structured translations with the configured model', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(
      url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    );
    assert.equal(new Headers(options.headers).get('x-goog-api-key'), 'gemini-test');
    assert.equal(JSON.parse(String(options.body)).generationConfig.responseMimeType, 'application/json');
    return Response.json({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [{ thought: true, text: 'Ignore this part' }, { text: '{"translations":["Bonjour"]}' }],
          },
        },
      ],
    });
  });
  assert.deepEqual(
    await providers.gemini.translate({ text: ['Hello'], source: 'en', target: 'fr' }, 'gemini-test'),
    ['Bonjour'],
  );
});

test('OpenAI requests structured output and rejects a result with missing translations', async (context) => {
  const batch = { text: ['Hello'], source: 'en', target: 'fr' };
  let translated = ['Bonjour'];
  context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer openai-test');
    const request = JSON.parse(String(options.body));
    assert.equal(request.model, 'configured-model');
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.store, false);
    return Response.json({
      status: 'completed',
      output: [
        { type: 'reasoning' },
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify({ translations: translated }) }],
        },
      ],
    });
  });
  assert.deepEqual(await providers.openai.translate(batch, 'openai-test', 'configured-model'), ['Bonjour']);
  translated = [];
  await assert.rejects(
    () => providers.openai.translate(batch, 'openai-test', 'configured-model'),
    /openai_invalid_response/,
  );
});
import {
  decryptProviderCredential,
  encryptProviderCredential,
} from '../packages/shared/src/provider-credentials';

test('protects stored provider credentials and binds them to their provider', () => {
  const key = Buffer.alloc(32, 1);
  const encrypted = encryptProviderCredential('unit-test-provider-key', key, 7);
  assert.notEqual(encrypted, encryptProviderCredential('unit-test-provider-key', key, 7));
  assert.equal(decryptProviderCredential(encrypted, key, 7), 'unit-test-provider-key');
  assert.throws(() => decryptProviderCredential(encrypted, key, 8));
  assert.throws(() => decryptProviderCredential(encrypted, Buffer.alloc(32, 2), 7));
});

const article = articleSchema.parse({
  postId: 42,
  sourceHost: 'www.wordpress.example',
  title: 'Travel to Europe',
  content: '<p>Read the <a href="/travel">travel news</a>.</p>',
  slug: 'travel-to-europe',
  publishedAt: '2026-11-21T09:00:00Z',
  modifiedAt: '2026-11-21T09:01:00Z',
  status: 'publish',
  canonical: 'https://wordpress.example/travel',
  categories: ['Travel', 'News'],
});

test('normalizes aliases on the same hostname and applies the local quota date', () => {
  assert.equal(normalizeHost('WWW.FR.TTW.TEST.:3001'), 'fr.ttw.test');
  assert.equal(localDay(new Date('2026-11-21T20:00:00Z'), 'Asia/Kolkata'), '2026-11-22');
});

test('hashes content independently of edit time and taxonomy order', () => {
  assert.equal(
    contentHash(article),
    contentHash({ ...article, modifiedAt: article.publishedAt, categories: ['News', 'Travel'] }),
  );
  assert.notEqual(contentHash(article), contentHash({ ...article, content: 'Updated' }));
  assert.notEqual(contentHash(article), contentHash({ ...article, status: 'withdrawn' }));
});

test('authenticates the exact event bytes and rejects old signatures', () => {
  const body = Buffer.from(JSON.stringify(article));
  const now = Date.parse('2026-11-21T09:01:00Z');
  const sent = String(now / 1000);
  const id = 'word-press-request-id';
  const signature = signWebhook(body, sent, id, 'test-key');
  assert.equal(verifyWebhook(body, sent, id, signature, 'test-key', now), true);
  assert.equal(
    verifyWebhook(Buffer.concat([body, Buffer.from(' ')]), sent, id, signature, 'test-key', now),
    false,
  );
  assert.equal(verifyWebhook(body, sent, id + '-different', signature, 'test-key', now), false);
  assert.equal(verifyWebhook(body, sent, id, signature, 'test-key', now + 301_000), false);
});

test('checks salted password hashes', () => {
  const hash = passwordHash('local-test-passphrase');
  assert.equal(validPassword('local-test-passphrase', hash), true);
  assert.equal(validPassword('other-passphrase', hash), false);
  assert.notEqual(passwordHash('local-test-passphrase'), hash);
});

test('translates text without changing allowed HTML or interpreting provider markup', () => {
  const html = '<h2>Travel</h2><p>Hello [gallery] <a href="/travel">Europe</a></p><script>alert(1)</script>';
  const pieces = htmlSegments(html);
  assert.deepEqual(pieces.segments, ['Travel', 'Hello', 'Europe']);
  const result = pieces.render(['Voyage', 'Bonjour', '<Europe>']);
  assert.match(result, /<h2>Voyage<\/h2>/);
  assert.match(result, /Bonjour \[gallery\] <a href="\/travel">&lt;Europe&gt;<\/a>/);
  assert.doesNotMatch(result, /script|alert/);
  assert.throws(() => pieces.render(['Voyage']));
});

test('localizes known internal links and retains the original destination for unknown ones', () => {
  const result = rewriteLinks(
    '<a href="/travel?a=1#section">Page</a><a href="/other">Other</a>',
    article.canonical,
    new Map([[article.canonical, '/article/voyage-42']]),
  );
  assert.match(result, /href="\/article\/voyage-42\?a=1#section"/);
  assert.match(result, /href="https:\/\/wordpress.example\/other"/);
});

test('creates unique localized slugs and escapes metadata for HTML and script contexts', () => {
  assert.equal(localizedSlug('L’actualité à Montréal', 42), 'l-actualite-a-montreal-42');
  assert.notEqual(localizedSlug('Actualité', 42), localizedSlug('Actualité', 43));
  assert.equal(articlePath('東京-42'), '/article/%E6%9D%B1%E4%BA%AC-42');
  assert.match(
    links('https://ttw.test/?v="', [{ code: 'fr-FR', url: 'https://fr.ttw.test/article/x' }]),
    /v=&quot;/,
  );
  assert.equal(jsonLd({ title: '</script>' }), '{"title":"\\u003c/script>"}');
});

test('the mock is opt-in and marks all translations as demonstration content', async () => {
  const prior = process.env.ALLOW_MOCK_TRANSLATION;
  delete process.env.ALLOW_MOCK_TRANSLATION;
  const input = { text: ['travel'], source: 'en', target: 'fr-FR' };
  await assert.rejects(() => providers.mock.translate(input), /mock_disabled/);
  process.env.ALLOW_MOCK_TRANSLATION = 'true';
  try {
    assert.deepEqual(await providers.mock.translate(input), ['[fr-FR · Démo] travel']);
  } finally {
    if (prior === undefined) delete process.env.ALLOW_MOCK_TRANSLATION;
    else process.env.ALLOW_MOCK_TRANSLATION = prior;
  }
});

test('DeepL uses the configured endpoint and translates a batched French request', async (context) => {
  const prior = process.env.DEEPL_API_KEY;
  process.env.DEEPL_API_KEY = 'unit-test:fx';
  try {
    context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      assert.equal(url, 'https://api-free.deepl.com/v2/translate');
      assert.equal(new Headers(options.headers).get('authorization'), 'DeepL-Auth-Key unit-test:fx');
      assert.deepEqual(JSON.parse(String(options.body)), {
        text: ['Hello'],
        source_lang: 'EN',
        target_lang: 'FR',
      });
      return new Response(JSON.stringify({ translations: [{ text: 'Bonjour' }] }));
    });
    assert.deepEqual(await providers.deepl.translate({ text: ['Hello'], source: 'en-US', target: 'fr-FR' }), [
      'Bonjour',
    ]);
    context.mock.restoreAll();
    context.mock.method(globalThis, 'fetch', async () => new Response('{'));
    await assert.rejects(
      () => providers.deepl.translate({ text: ['Hello'], source: 'en-US', target: 'fr-FR' }),
      /deepl_invalid_response/,
    );
  } finally {
    if (prior === undefined) delete process.env.DEEPL_API_KEY;
    else process.env.DEEPL_API_KEY = prior;
  }
});
