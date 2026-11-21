# TTW Translation Platform

One central application serves localized travel news by hostname. Start with the French pilot and a single WordPress source. The admin console uses the supplied TTW dashboard design.

## Run the dashboard preview

From this folder, using Node.js 24 LTS and npm:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173/. The development server starts with labelled sample data, including the 104-domain dashboard shown in the reference. The domain form, article detail tabs, job actions, search, and status filters are available in the preview. Use **Connect to live data** once the API is running. A production build opens on the sign-in screen.

## Run the French pilot locally

1. Copy `.env.example` to `.env` and choose a local admin password and three independent secrets. Use `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` once per secret. Set `SOURCE_HOST` to the WordPress hostname when connecting a site.
2. Run `docker compose up -d --wait` for MySQL 8.4 and Redis. If you have your own local services, set their connection URLs in `.env`.
3. Run `npm run migrate` and `npm run seed`. The seed creates the admin account, French language, Premium group, and one domain. It preserves existing records. Use the configured `ADMIN_EMAIL` and `ADMIN_PASSWORD` to sign in.
4. Run `npm run dev:api`, `npm run dev:worker`, and `npm run dev:web` in separate terminals. Keep `npm run dev` running for the development admin UI. The Vite proxy targets port 3000.
5. Run `npm run smoke` in another terminal against a fresh one-domain setup. This sends a signed fixture through the API, waits for BullMQ publishing, checks the public site and dashboard API, and withdraws the test article.

Use `curl.exe -H "Host: fr.ttw.test" http://127.0.0.1:3001/` on Windows to preview the public site with the seeded hostname. For browser access, point the hostname at loopback through your local resolver. The built admin UI is served from the API on port 3000 after `npm run build` and `npm run start:api`.

### Environment

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Set to `production` on the VPS. |
| `DATABASE_URL` | MySQL connection URI with URL-encoded credentials. |
| `REDIS_URL` | BullMQ, API rate limits, and worker heartbeat. |
| `API_PORT`, `WEB_PORT`, `BIND_HOST` | Defaults are 3000, 3001, and loopback. |
| `SOURCE_HOST` | Allowed WordPress hostname, without protocol or path. |
| `PILOT_HOST`, `PILOT_ORIGIN` | Domain record seeded for the French pilot. Set the production origin to the exact HTTPS canonical origin. |
| `WEBHOOK_API_KEY`, `WEBHOOK_SECRET` | Independent credentials shared with the WordPress connector. Each requires at least 32 characters. |
| `JWT_SECRET` | Independent random admin signing secret of at least 32 characters. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Initial Super Admin account. Password requires at least 12 characters. Rerunning the seed does not change an existing password. |
| `DEEPL_API_KEY` | Server-side DeepL key. The adapter selects the DeepL endpoint from the key type. |
| `DEEPL_COST_INR_PER_MILLION` | Estimated rupee cost per million characters used when seeding DeepL. |
| `ALLOW_MOCK_TRANSLATION` | Local-only mock when set to `true`. Mock article pages are labelled and excluded from feed, sitemap, and hreflang output. |
| `WORKER_CONCURRENCY` | Maximum simultaneous translations per worker instance. Defaults to 2. |

To switch an existing pilot from mock to DeepL, set the DeepL key and cost, rerun the seed to register the provider, then edit the Premium group in **Translation Groups**. Existing jobs retain their selected provider. Use fresh content or a fresh staging database to verify DeepL separately. [DeepL API authentication and endpoints](https://developers.deepl.com/docs/getting-started/auth)

### Project layout

| Path | Responsibility |
| --- | --- |
| `apps/api` | NestJS login, signed ingestion, transactional distribution, and admin REST API. |
| `apps/worker` | DB-to-BullMQ dispatch, adapter calls, retry and fallback, HTML validation, and publishing. |
| `apps/web` | Shared hostname-based SSR, localized URLs, SEO, sitemap, RSS, and redirects. |
| `admin` | React and Tailwind admin console with sample and live modes. |
| `packages` | MySQL access, provider adapters, webhook signatures, and shared content handling. |
| `database/migrations` | Versioned MySQL schema. |
| `wordpress-plugin/translation-connector` | WordPress event outbox and signed delivery. |
| `deployment`, `nginx`, `docs` | PM2 process configuration, reverse proxy template, and pilot operations. |

## Connect WordPress

1. Copy `wordpress-plugin/translation-connector` to `wp-content/plugins/`, then activate **TTW Translation Connector**.
2. Add these constants in `wp-config.php` before WordPress loads. Use the same API key and HMAC secret as the backend. Use HTTPS for staging and production.

```php
define('TTW_TRANSLATION_ENDPOINT', 'https://admin.example.com/api/v1/webhooks/wordpress/article');
define('TTW_TRANSLATION_API_KEY', 'your-api-key');
define('TTW_TRANSLATION_SECRET', 'your-hmac-secret');
```

3. Configure WordPress cron to run regularly on the source server. After publishing a test post, review pending and failed events under **Tools → Translation Connector**. Failed deliveries can be retried there.
4. Verify the article, job, and target page from the admin console. WordPress snapshots are signed over the exact JSON bytes and retained locally until the central API accepts them.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
php -l wordpress-plugin/translation-connector/translation-connector.php
npm run smoke
```

Run `npm run format` to format the TypeScript, React, and stylesheet source with Prettier.

The smoke test requires the API, worker, SSR process, MySQL, and Redis. The GitHub Actions workflow starts the services and runs the smoke test with the local mock.

See the [API reference](docs/api.md) and [VPS deployment and migration guide](docs/deployment.md) for endpoint contracts, backup and restore, and rollout checks.
