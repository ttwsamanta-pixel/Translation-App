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
3. Run `npm run migrate` and `npm run seed`. The seed creates the admin account, French language, and Premium group. It creates the optional pilot domain when both pilot variables are set and preserves existing records. Use the configured `ADMIN_EMAIL` and `ADMIN_PASSWORD` to sign in.
4. Run `npm run dev:api`, `npm run dev:worker`, and `npm run dev:web` in separate terminals. Keep `npm run dev` running for the development admin UI. The Vite proxy targets port 3000.
5. Run `npm run smoke` in another terminal against a fresh one-domain setup. This sends a signed fixture through the API, waits for BullMQ publishing, checks the public site and dashboard API, and withdraws the test article.

Use `curl.exe -H "Host: fr.ttw.test" http://127.0.0.1:3001/` on Windows to preview the public site with the seeded hostname. For browser access, point the hostname at loopback through your local resolver. The built admin UI is served from the API on port 3000 after `npm run build` and `npm run start:api`.

### Environment

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Set to `production` on the VPS. |
| `DATABASE_URL` | MySQL connection URI with URL-encoded credentials. |
| `REDIS_URL` | BullMQ, API rate limits, worker heartbeat, and public homepage caching. |
| `API_PORT`, `WEB_PORT`, `BIND_HOST` | Defaults are 3000, 3001, and loopback. |
| `SOURCE_HOST` | Allowed WordPress hostname, without protocol or path. |
| `SOURCE_SITE_ID` | Optional ID that must match the Site ID in the source WordPress connector when configured. |
| `PILOT_HOST`, `PILOT_ORIGIN` | Optional automated pilot domain seed. Leave both unset for domain registration through the admin dashboard. |
| `WEBHOOK_API_KEY`, `WEBHOOK_SECRET` | Independent credentials shared with the WordPress connector. Each requires at least 32 characters. |
| `JWT_SECRET` | Independent random admin signing secret of at least 32 characters. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Initial Super Admin account. Password requires at least 12 characters. Rerunning the seed does not change an existing password. |
| `DEEPL_API_KEY` | Optional server-side fallback when a key has not been saved in the admin panel. |
| `PROVIDER_CREDENTIAL_SECRET` | 32 random bytes in hex for encrypting saved keys. The VPS setup script generates this. For local development, generate it with `openssl rand -hex 32`. |
| `DEEPL_COST_INR_PER_MILLION` | Estimated rupee cost per million characters used when seeding DeepL. |
| `ALLOW_MOCK_TRANSLATION` | Local-only mock when set to `true`. Mock article pages are labelled and excluded from feed, sitemap, and hreflang output. |
| `WORKER_CONCURRENCY` | Maximum simultaneous translations per worker instance. Defaults to 2. |

Sign in as an admin and open **Providers (APIs)**. Edit the preconfigured DeepL, Google Cloud Translation Basic v2, Gemini, or OpenAI provider, or choose **Add provider** for a separate key or model. Save the API key and enable the provider. Configure its primary or fallback role in **Translation Groups**. Keys are encrypted at rest. Saved DeepL keys take precedence over the optional environment key. Existing jobs retain their selected provider. Optional request caps apply per minute and per UTC day, with a separate cap on concurrent requests. The dashboard shows an estimate based on the rate you enter per million source characters. The Gemini and OpenAI API bills are based on token usage and may differ.

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

1. Deploy the central app and apply migrations before updating the connector. Copy the entire `wordpress-plugin/translation-connector` folder to the source site's `wp-content/plugins/`. Activate **TTW Translation Connector** if needed.
2. Open **Translation Platform → Settings**. Enter the central application URL and the backend's webhook API key and secret, then use **Test saved connection**. Existing `wp-config.php` constants take precedence and can continue to supply the connection:

```php
define('TTW_TRANSLATION_ENDPOINT', 'https://admin.example.com/api/v1/webhooks/wordpress/article');
define('TTW_TRANSLATION_API_KEY', 'your-api-key');
define('TTW_TRANSLATION_SECRET', 'your-hmac-secret');
```

3. Configure Manual, Automatic, or Disabled for the source categories. Unconfigured posts stay in WordPress until a rule applies. Use **Sync categories** to populate the central Distribution editor. Start with one Manual category, then select an eligible published post under **Translation Platform → Articles** and send it.
4. Keep WordPress cron running regularly. Monitor **Translation Platform → Logs** and verify the accepted article, queued job, and published page in the central app. Existing pending and failed outbox entries remain available after the connector upgrade.

## Manage distribution and edition design

- **Distribution** controls which source categories reach each group or individual domain. Before the first rule is created, eligible domains receive all incoming categories. After that, an incoming article needs an enabled matching rule. A rule's daily quota counts distinct source articles by UTC day. A domain's quota counts new article allocations in its configured timezone. Updated translations for previously allocated articles reuse their original allocation when the destination still matches.
- **Domains** can override the group's primary provider, fallback provider, daily limit and queue priority. A matched rule can override provider selection and queue priority for its own category. Existing translation jobs keep their assigned providers.
- **Website** manages the shared design, logo, menus, homepage sections, static pages, videos, magazine issues, advertisements and social sharing. Save a draft, preview it with sample content, and publish the version. To roll back, load and publish a previous version. Domain overrides inherit any values left out.
- **Localization** stores UI strings and category labels by language. Configure edition-specific media, navigation and static page copy through the domain overrides. Each enabled domain uses the shared renderer and serves the published articles in that edition. The article language selector links to available translations of that story.
- **Users & Roles** manages access to editing, distribution, website design, account administration and read-only viewing. **Admin Activity** shows authenticated management requests and their HTTP results.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
php -l wordpress-plugin/translation-connector/translation-connector.php
php -l wordpress-plugin/translation-connector/admin.php
npm run smoke
```

Run `npm run format` to format the TypeScript, React, and stylesheet source with Prettier.

The smoke test requires the API, worker, SSR process, MySQL, and Redis. The GitHub Actions workflow starts the services and runs the smoke test with the local mock.

See the [API reference](docs/api.md) and [VPS deployment and migration guide](docs/deployment.md) for endpoint contracts, backup and restore, and rollout checks.
