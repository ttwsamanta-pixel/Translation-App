# VPS pilot deployment

## Docker Compose with the existing Caddy proxy

Use this deployment when the VPS already runs Docker Compose and has Caddy on ports 80 and 443. The project runs its own MySQL, Redis, API, public web, and worker containers. Caddy reaches the API and public web on host loopback ports 8200 and 8201.

From the checkout on the VPS:

```sh
bash deployment/prepare-vps.sh
nano .env.vps
```

Fill in `ADMIN_EMAIL` and `SOURCE_HOST` (the WordPress hostname). Use the generated `ADMIN_PASSWORD` on the sign-in page. The database password is generated as hex so it can be used in the connection URI. The seed and migrations run as a one-shot container before the application starts. Leave `PILOT_HOST` and `PILOT_ORIGIN` unset when you plan to add your existing domains in the admin dashboard.

```sh
docker compose --env-file .env.vps -f compose.vps.yaml up -d --build --wait
curl -fsS http://127.0.0.1:8200/ready
```

Point the admin hostname at the VPS. Use `systemctl show caddy -p ExecStart` to identify the active Caddy configuration. Add the admin hostname block from `deployment/Caddyfile.example` with the real name and any port override from `.env.vps`. For a standard Caddyfile at `/etc/caddy/Caddyfile`, validate it with `caddy validate --config /etc/caddy/Caddyfile`, then run `systemctl reload caddy`. Use the existing site's DNS and certificate workflow.

Open the admin hostname over HTTPS and sign in. Add missing locale codes under **Languages → Add language**, then register your existing hostnames under **Domains → Add domain**. Set Public origin to the exact existing HTTPS origin, including `www` when appropriate. Add Caddy routes for public domains and switch their DNS only when you are ready to migrate their traffic. Follow the WordPress connector setup in the README to send one test article. For later updates, pull the release and run the same Compose command. Check the setup container's logs if migrations or seeding fail.

Save a translation key under **Providers (APIs)**, enable that provider, and select it for the appropriate group before sending articles. Keep `PROVIDER_CREDENTIAL_SECRET` in the protected configuration backup alongside the database backup. For an existing deployment, rerun `bash deployment/prepare-vps.sh` to add this secret to the existing `.env.vps`. The admin and API serve `X-Robots-Tag: noindex`. The public sites retain their published article indexing rules.

## Automatic deployment with GitHub Actions

`.github/workflows/deploy.yml` runs after **Verify pilot** succeeds for a push to `main`. It connects over SSH and requests the exact verified commit. The VPS serializes deployments, applies a fast-forward update, runs the database setup and Compose deployment, then checks API readiness. This workflow covers the containers on the VPS. Deploy the WordPress connector separately when that plugin changes.

### One-time VPS setup

From the Hostinger terminal as the owner of `/opt/translation-app`, pull the workflow and install its SSH command outside the checkout. The existing root-owned Hostinger installation uses these commands:

```sh
cd /opt/translation-app
git pull --ff-only
install -m 0755 deployment/auto-deploy-vps.sh /usr/local/sbin/ttw-translation-deploy
install -d -m 0700 /root/.ssh
ssh-keygen -t ed25519 -N '' -C ttw-translation-github-actions -f /root/.ssh/ttw-translation-actions
```

Add this public key once. OpenSSH will limit this key to the deployment command.

```sh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
{
  printf '\n'
  sed 's!^!restrict,command="/usr/local/sbin/ttw-translation-deploy" !' /root/.ssh/ttw-translation-actions.pub
} >> /root/.ssh/authorized_keys
```

### GitHub Actions settings

Open the repository's **Settings → Secrets and variables → Actions**. Add the following values:

| Kind | Name | Value |
| --- | --- | --- |
| Repository variable | `VPS_SSH_HOST` | Public VPS IP or its SSH hostname. |
| Repository secret | `VPS_SSH_KEY` | Complete private key from `/root/.ssh/ttw-translation-actions`. Paste it directly into GitHub. |
| Repository secret | `VPS_SSH_KNOWN_HOSTS` | A single line with the value of `VPS_SSH_HOST`, then a space, then the key type and public key from `/etc/ssh/ssh_host_ed25519_key.pub`. |

For port 22, run this in the Hostinger terminal to generate the known-hosts line. Substitute the same address you entered for `VPS_SSH_HOST`.

```sh
awk '{print "VPS_ADDRESS", $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

The default connection is `root` on port `22`. For a different existing SSH account or port, add repository variables `VPS_SSH_USER` and/or `VPS_SSH_PORT`. Ensure that account owns the checkout, can use Docker, and has the restricted key. If the port is different, format the host field in the known-hosts entry as `[host]:port`.

Open **Actions → Verify pilot**, choose the latest successful push run on `main`, and select **Re-run all jobs** to test the setup. Check **Deploy to Hostinger** for the deployed commit and readiness result. Future pushes to `main` follow the same sequence. Keep local configuration in the ignored `.env.vps` and the checkout clean for fast-forward deploys.

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
| Later rollout | Additional adapters such as Azure and Amazon Translate, provider-specific throttles and budget enforcement, advanced taxonomy/media tools, full site templates, and staged onboarding of remaining domains. |
