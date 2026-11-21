# Pilot API

The API is same-origin with the built admin client. Routes use JSON except health checks and static assets.

| Method and path | Authentication | Result |
| --- | --- | --- |
| `GET /health`, `GET /liveness` | None | Process liveness. |
| `GET /ready` | None | 200 if Redis and MySQL are reachable, otherwise 503. |
| `POST /api/v1/auth/login` | Email and password | Bearer JWT valid for four hours, display email, and role. |
| `POST /api/v1/webhooks/wordpress/article` | API key and HMAC | 202 with the article ID and allocated job count. Also available at `/article/update`. |
| `GET /api/v1/overview?days=30` | JWT | Activity, usage estimates, recent jobs, statuses, and service health. Accepts 7, 30, or 90 days. |
| `GET /api/v1/catalog/:resource` | JWT | Lists `articles`, `jobs`, `domains`, `groups`, `providers`, `languages`, `memory`, `redirects`, `taxonomy`, `logs`, or `users`. Accepts `q`, `status`, and `page`. The users list requires admin access. |
| `GET /api/v1/articles/:id` | JWT | Current source snapshot, translation versions, and jobs. |
| `POST /api/v1/articles/:id/translate` | Editor or manager | Allocate eligible domains within their limits. Accepts `{}` or `{"domainId":1}`. |
| `PATCH /api/v1/jobs/:id` | Editor or manager | Accepts an `action` of `retry`, `cancel`, `approve`, or `unpublish`. |
| `POST /api/v1/domains`, `PATCH /api/v1/domains/:id` | Translation manager, admin, or Super Admin | Create or save a complete domain record. |
| `POST /api/v1/groups`, `PATCH /api/v1/groups/:id` | Translation manager, admin, or Super Admin | Save name, description, daily limit, priority, enablement, and provider routing. |
| `PATCH /api/v1/providers/:id` | Translation manager, admin, or Super Admin | Save enablement and the estimated rupee cost per million characters. |

Domain fields are `hostname`, `origin`, `language_id`, `group_id`, `daily_limit` (nullable to inherit from the group), `timezone`, `enabled`, `sitemap_enabled`, `rss_enabled`, and `manual_approval`.

## Signing WordPress events

Set `Content-Type: application/json` and send these request headers:

- `X-Api-Key` is the configured source API key.
- `X-Request-Id` is stable across attempts, typically a UUID.
- `X-Timestamp` is a Unix timestamp in seconds. Recompute it with every attempt. The API accepts a five-minute clock difference.
- `X-Signature` is the lowercase hexadecimal HMAC-SHA256 of `timestamp + "." + requestId + "." + rawBody` using the webhook secret.

The request body requires `postId`, `sourceHost`, `title`, `content`, `slug`, `publishedAt`, `modifiedAt`, `status`, and `canonical`. Optional fields include excerpt, image and alt text, author, categories, tags, SEO text, article type, and language. A duplicate request ID with the same JSON returns the existing article. Reusing the ID for different bytes returns 409. Republishing unchanged content with a new ID records the receipt without creating a job. Use `withdrawn` to remove a source article from public pages.

## Worker and publication

MySQL owns durable job state. The worker checks for pending rows and uses stable BullMQ IDs so dispatch can be repeated. BullMQ applies exponential backoff and the worker records attempts and fallback usage. Manual approval leaves a translation in review until approved. The public request resolves the incoming hostname through the domain record, then reads published data from MySQL.
