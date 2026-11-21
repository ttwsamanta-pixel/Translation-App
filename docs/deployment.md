# VPS pilot deployment

## Docker Compose with the existing Caddy proxy

Use this deployment when the VPS already runs Docker Compose and has Caddy on ports 80 and 443. The project runs its own MySQL, Redis, API, public web, and worker containers. Caddy reaches the API and public web on host loopback ports 8200 and 8201.

From the checkout on the VPS:

```sh
bash deployment/prepare-vps.sh
nano .env.vps
```

Fill in `ADMIN_EMAIL`, `SOURCE_HOST` (the WordPress hostname), `PILOT_HOST` (the French hostname), `PILOT_ORIGIN` (the matching HTTPS origin without a trailing slash), and `DEEPL_API_KEY`. Use the generated `ADMIN_PASSWORD` on the sign-in page. The database password is generated as hex so it can be used in the connection URI. The seed and migrations run as a one-shot container before the application starts.

```sh
docker compose --env-file .env.vps -f compose.vps.yaml up -d --build --wait
curl -fsS http://127.0.0.1:8200/ready
```

Create DNS records for the admin and French hostnames pointing at the VPS. Use `systemctl show caddy -p ExecStart` to identify the active Caddy configuration. Add the two hostname blocks from `deployment/Caddyfile.example` to that configuration, with the real names and any port overrides from `.env.vps`. For a standard Caddyfile at `/etc/caddy/Caddyfile`, validate it with `caddy validate --config /etc/caddy/Caddyfile`, then run `systemctl reload caddy`. Use the existing site's DNS and certificate workflow.

Open the admin hostname over HTTPS and sign in. Follow the WordPress connector setup in the README to send one test article. For later updates, pull the release and run the same Compose command. Check the setup container's logs if migrations or seeding fail.

## Install directly with Nginx and PM2

Provision a Linux VPS with Node.js 24 LTS, MySQL 8.4, Redis, Nginx, and PM2. Bind MySQL, Redis, and the Node.js apps to private interfaces. Configure Redis persistence and a `noeviction` policy for BullMQ. Prefer a distinct Redis instance for the queue when adding application caching.

After checking out the verified release on the VPS, create `.env` with production settings and restrict access to the service account. Use the exact WordPress source hostname, a real DeepL key, and the pilot hostname and HTTPS origin. Start with an isolated staging source and domain before routing live news traffic.

```sh
npm ci
npm run build
npm run migrate
npm run seed
pm2 startOrReload deployment/ecosystem.config.cjs --update-env
pm2 save
curl -fsS http://127.0.0.1:3000/ready
```

Run the seed once for initial setup, or repeat it to insert missing reference rows. Configure PM2 startup for the service account using the command printed by `pm2 startup`. The pilot runs translation, validation, publishing, and dispatch within the worker process. CPU and memory metrics in development are example dashboard data.

## Nginx and Cloudflare

1. Set proxied DNS records for the admin/API hostname and pilot news hostname at the VPS address. Use a Cloudflare Full (strict) TLS configuration with origin certificates valid for each hostname.
2. Copy the Nginx template, substitute the actual domain names and certificate paths, and validate with `nginx -t` before reloading. Add a public server block or certificate coverage for each additional hostname. Keep all public hostnames upstream of the same SSR process.
3. Trust Cloudflare client IP headers only from Cloudflare's published source ranges if per-client origin throttling is required. Restrict direct access to origins and keep admin/API paths and authorization responses out of edge caching. Start with public HTML cache bypass while verifying withdrawals and URL migration.
4. Confirm unknown hostnames return 404 or are rejected by Nginx. Verify enabled local hostnames return the expected language.

## Backup and restore

- Store encrypted MySQL backups off the VPS. Use `mysqldump --single-transaction --no-tablespaces` with credentials in a protected option file and test a restore into an isolated MySQL database.
- Back up encrypted deployment configuration, WordPress database and plugin outbox, Nginx configuration, origin certificate files, and the Redis volume. Keep secrets in a separately restricted store.
- Schedule backups and retention through the VPS backup system. Treat MySQL as the source of truth, and reconcile active jobs against the restored queue before accepting traffic.

## GTranslate pilot migration

1. Export the old URL list and crawl a sample to capture canonical URLs, hreflang, redirects, and indexability. Preserve that baseline for rollback.
2. Seed or create the pilot hostname and language and verify provider credentials. Add legacy per-host paths to the `redirects` table, with redirects pointing to live same-host destinations. Check for loops before cutover.
3. Publish a staging article and verify HTML, metadata, internal links, RSS, sitemap, and robots.txt using the pilot hostname. Verify a withdrawal and a duplicate delivery.
4. Lower the DNS TTL as needed and cut over the pilot only after validating TLS, logging, and rollback. Watch crawl errors, job failures, and provider usage before migrating another group of domains.
5. Roll back DNS and origin routing if the pilot fails. Keep a copy of the verified route map.

## Scope and activation

| Status | Pilot |
| --- | --- |
| Implemented | Central API and schema, WordPress connector, configurable domains, admin role checks, job pipeline, DeepL and local mock, basic fallback and retry, translation memory, review and publishing controls, shared SSR, and localized metadata. |
| Partial | Roles are preset. Administration supports domain and group settings, provider pricing and enablement, and job actions. Public rendering covers listings and article pages. Provider usage estimates are in INR. |
| External configuration | WordPress installation and source test, a real DeepL API plan and key, VPS, Cloudflare DNS and origin TLS, production backup scheduling, and legacy URL export. |
| Later rollout | Google Cloud, Gemini, OpenAI, encrypted provider credential management, provider-specific throttles and budget enforcement, advanced taxonomy/media tools, full site templates, and staged onboarding of remaining domains. |
