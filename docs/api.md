# Pilot API

The API is same-origin with the built admin client. Routes use JSON except health checks and static assets.

| Method and path | Authentication | Result |
| --- | --- | --- |
| `GET /health`, `GET /liveness` | None | Process liveness. |
| `GET /ready` | None | 200 if Redis and MySQL are reachable, otherwise 503. |
| `POST /api/v1/auth/login` | Email and password | Bearer JWT valid for four hours, display email, and role. |
| `POST /api/v1/webhooks/wordpress/article` | API key and HMAC | 202 with the article ID and allocated job count. Also available at `/article/update`. |
| `POST /api/v1/webhooks/wordpress/test` | API key and HMAC | Verifies the signed source hostname and optional site ID without ingesting an article. |
| `POST /api/v1/webhooks/wordpress/categories` | API key and HMAC | Replaces the source taxonomy snapshot used in the distribution rule editor. |
| `POST /api/v1/webhooks/wordpress/articles/bulk` | API key and HMAC | Accepts a JSON array of up to 20 valid article events in one transaction. The existing 1 MB request limit applies. |
| `GET /api/v1/overview?days=30` | JWT | Activity, usage estimates, recent jobs, statuses, and service health. Accepts 7, 30, or 90 days. |
| `GET /api/v1/catalog/:resource` | JWT | Lists `articles`, `jobs`, `domains`, `groups`, `providers`, `languages`, `memory`, `redirects`, `taxonomy`, `logs`, or `users`. Accepts `q`, `status`, and `page`. The users list requires admin access. |
| `GET /api/v1/articles/:id` | JWT | Current source snapshot, translation versions, and jobs. |
| `POST /api/v1/articles/:id/translate` | Editor or manager | Allocate eligible domains within their limits. Accepts `{}` or `{"domainId":1}`. |
| `PATCH /api/v1/jobs/:id` | Editor or manager | Accepts an `action` of `retry`, `cancel`, `approve`, or `unpublish`. |
| `POST /api/v1/domains`, `PATCH /api/v1/domains/:id` | Translation manager, admin, or Super Admin | Create or save a complete domain record. |
| `POST /api/v1/languages` | Translation manager, admin, or Super Admin | Register a language name and locale code. |
| `GET /api/v1/domain-options` | Translation manager, admin, or Super Admin | Return languages and groups for domain forms. |
| `GET /api/v1/distribution/rules`, `GET /api/v1/distribution/usage` | Translation manager, admin, or Super Admin | List category rules, target choices, and domain quotas. |
| `POST /api/v1/distribution/rules`, `PATCH /api/v1/distribution/rules/:id` | Translation manager, admin, or Super Admin | Save a category rule with one target group or individual domain. |
| `GET /api/v1/website`, `GET /api/v1/website/versions/:id` | Translation manager, admin, or Super Admin | Load the active design, configuration choices, or a saved version. |
| `POST /api/v1/website/versions`, `POST /api/v1/website/versions/:id/publish` | Translation manager, admin, or Super Admin | Save a draft version or publish a saved version. |
| `PUT /api/v1/website/overrides/:domainId`, `PUT /api/v1/website/translations/:languageId` | Translation manager, admin, or Super Admin | Save partial per-domain design overrides or a language's `{ labels, categories }` dictionary. |
| `POST /api/v1/groups`, `PATCH /api/v1/groups/:id` | Translation manager, admin, or Super Admin | Save name, description, daily limit, priority, enablement, and provider routing. |
| `POST /api/v1/providers` | Admin or Super Admin | Add a named provider, using `deepl`, `google_cloud`, `gemini`, or `openai` as the adapter. |
| `PATCH /api/v1/providers/:id` | Translation manager, admin, or Super Admin | Save enablement, model where applicable, estimated rupee cost, and optional request limits. Admins can update the write-only `api_key`. |
| `POST /api/v1/providers/test` | Translation manager, admin, or Super Admin | Sends one test phrase with the saved provider configuration. Accepts `id` and an optional target language code. |

Domain fields are `hostname`, `origin`, `language_id`, `group_id`, `daily_limit` (nullable to inherit from the group), `timezone`, `enabled`, `sitemap_enabled`, `rss_enabled`, and `manual_approval`. Optional `provider_id`, `fallback_provider_id`, and `priority` override the group defaults. Sending null restores inheritance.

## Signing WordPress events

Set `Content-Type: application/json` and send these request headers:

- `X-Api-Key` is the configured source API key.
- `X-Request-Id` is stable across attempts, typically a UUID.
- `X-Timestamp` is a Unix timestamp in seconds. Recompute it with every attempt. The API accepts a five-minute clock difference.
- `X-Signature` is the lowercase hexadecimal HMAC-SHA256 of `timestamp + "." + requestId + "." + rawBody` using the webhook secret.

The request body requires `postId`, `sourceHost`, `title`, `content`, `slug`, `publishedAt`, `modifiedAt`, `status`, and `canonical`. Optional fields include excerpt, image and alt text, author, categories, tags, SEO text, article type, and language. A duplicate request ID with the same JSON returns the existing article. Reusing the ID for different bytes returns 409. Republishing unchanged content with a new ID records the receipt without creating a job. Use `withdrawn` to remove a source article from public pages.

## Worker and publication

MySQL owns durable job state. The worker checks for pending rows and uses stable BullMQ IDs so dispatch can be repeated. BullMQ applies exponential backoff and the worker records attempts and fallback usage. Manual approval leaves a translation in review until approved. The public request resolves the incoming hostname through the domain record, then reads published data from MySQL.
