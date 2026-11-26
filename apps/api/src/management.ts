import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import type { PoolConnection } from 'mysql2/promise';
import { z } from 'zod';
import { execute, rows, transaction } from '../../../packages/database/src/db';
import { refreshWebsiteCache } from '../../../packages/database/src/website';
import { Article, localDay, normalizeHost } from '../../../packages/shared/src/article';
import { passwordHash } from '../../../packages/shared/src/auth';
import { production, secret } from '../../../packages/shared/src/config';
import {
  isProviderKind,
  providerCatalog,
  providerKinds,
} from '../../../packages/shared/src/provider-catalog';
import {
  decryptProviderCredential,
  encryptProviderCredential,
  providerCredentialEncryptionKey,
} from '../../../packages/shared/src/provider-credentials';
import { providers as adapters, ProviderError } from '../../../packages/providers/src';
import { reserveProviderRequest, type ProviderLimits } from '../../../packages/providers/src/limits';
import { redis } from '../../../packages/shared/src/queue';
import {
  accountManagers,
  contentEditors as editors,
  domainManagers,
  roles,
  siteManagers,
  translationManagers as managers,
} from '../../../packages/shared/src/roles';
import {
  defaultWebsite,
  localizationSchema,
  overrideSchema,
  websiteSchema,
} from '../../../packages/shared/src/website';
import { distribute } from './ingest';

export type ApiRequest = Request & { rawBody?: Buffer; adminId?: number };
type User = { id: number; email: string; password_hash: string; role: string; enabled: number };
export const users = (field: 'id' | 'email', value: string | number) =>
  rows<User>(`SELECT id,email,password_hash,role,enabled FROM users WHERE ${field}=?`, [value]);

const monitoring = redis();
monitoring.on('error', () => {
  /* The dashboard shows Redis availability. */
});

async function authorize(request: Request, roles?: string[]) {
  const token = request.get('authorization')?.match(/^Bearer ([^ ]+)$/i)?.[1];
  let id: number;
  try {
    const value = jwt.verify(token ?? '', secret('JWT_SECRET'), {
      algorithms: ['HS256'],
      issuer: 'ttw-admin',
      audience: 'ttw-platform',
    });
    id = typeof value === 'object' ? Number(value.sub) : NaN;
    if (!Number.isSafeInteger(id)) throw new Error();
  } catch {
    throw new UnauthorizedException('Sign in to continue');
  }
  const [user] = await users('id', id);
  if (!user?.enabled) throw new UnauthorizedException('Account unavailable');
  (request as ApiRequest).adminId = user.id;
  if (roles && !roles.includes(user.role)) throw new ForbiddenException('Insufficient permission');
  return user;
}

const idSchema = z.coerce.number().int().positive().max(4_294_967_295);
const userSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(250).optional(),
  role: z.enum(roles),
  enabled: z.boolean(),
});
const groupSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500),
    daily_limit: z.number().int().min(0).max(10000),
    priority: z.number().int().min(1).max(32767),
    enabled: z.boolean(),
    provider_id: idSchema,
    fallback_provider_id: idSchema.nullable(),
  })
  .refine(
    (group) => group.provider_id !== group.fallback_provider_id,
    'Choose a different fallback provider',
  );
const providerSchema = z.object({
  enabled: z.boolean(),
  model: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/i)
    .optional(),
  cost_inr_per_million: z.number().min(0).max(9_999_999),
  requests_per_minute: z.number().int().min(1).max(100000).nullable().optional(),
  requests_per_day: z.number().int().min(1).max(10000000).nullable().optional(),
  concurrent_requests: z.number().int().min(1).max(500).nullable().optional(),
  api_key: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[!-~]+$/, 'Enter a key without spaces')
    .optional(),
});
const createProviderSchema = providerSchema.extend({
  name: z.string().trim().min(1).max(100),
  adapter: z.enum(providerKinds),
});
const ruleSchema = z
  .object({
    category: z.string().trim().min(1).max(200),
    group_id: idSchema.nullable(),
    domain_id: idSchema.nullable(),
    daily_limit: z.number().int().min(0).max(10000),
    priority: z.number().int().min(1).max(32767),
    provider_id: idSchema.nullable(),
    fallback_provider_id: idSchema.nullable(),
    enabled: z.boolean(),
  })
  .refine((rule) => Boolean(rule.domain_id) !== Boolean(rule.group_id), 'Choose one domain or one group')
  .refine(
    (rule) => !rule.provider_id || rule.provider_id !== rule.fallback_provider_id,
    'Choose a different fallback provider',
  );

async function checkRuleTargets(rule: z.infer<typeof ruleSchema>) {
  const [match] = await rows<{ valid: number }>(
    `SELECT
    (? IS NULL OR EXISTS (SELECT 1 FROM translation_groups WHERE id=?)) AND
    (? IS NULL OR EXISTS (SELECT 1 FROM domains WHERE id=?)) AND
    (? IS NULL OR EXISTS (SELECT 1 FROM translation_providers WHERE id=?)) AND
    (? IS NULL OR EXISTS (SELECT 1 FROM translation_providers WHERE id=?)) valid`,
    [
      rule.group_id,
      rule.group_id,
      rule.domain_id,
      rule.domain_id,
      rule.provider_id,
      rule.provider_id,
      rule.fallback_provider_id,
      rule.fallback_provider_id,
    ],
  );
  if (!match.valid) throw new BadRequestException('Choose existing destinations and providers');
}

async function saveProviderKey(conn: PoolConnection, id: number, value: string) {
  const key = providerCredentialEncryptionKey();
  if (!key)
    throw new ServiceUnavailableException('Provider credential encryption is not configured on the server');
  await execute(
    `INSERT INTO provider_credentials (provider_id,encrypted_key) VALUES (?,?)
      AS new ON DUPLICATE KEY UPDATE encrypted_key=new.encrypted_key`,
    [id, encryptProviderCredential(value, key, id)],
    conn,
  );
}

async function saveProviderLimits(conn: PoolConnection, id: number, policy: Partial<ProviderLimits>) {
  const { requests_per_minute, requests_per_day, concurrent_requests } = policy;
  if (
    requests_per_minute === undefined &&
    requests_per_day === undefined &&
    concurrent_requests === undefined
  )
    return;
  const [current] = await rows<ProviderLimits>(
    'SELECT requests_per_minute,requests_per_day,concurrent_requests FROM provider_policies WHERE provider_id=?',
    [id],
    conn,
  );
  await execute(
    `INSERT INTO provider_policies (provider_id,requests_per_minute,requests_per_day,concurrent_requests)
    VALUES (?,?,?,?) AS incoming ON DUPLICATE KEY UPDATE requests_per_minute=incoming.requests_per_minute,
      requests_per_day=incoming.requests_per_day,concurrent_requests=incoming.concurrent_requests`,
    [
      id,
      requests_per_minute === undefined ? (current?.requests_per_minute ?? null) : requests_per_minute,
      requests_per_day === undefined ? (current?.requests_per_day ?? null) : requests_per_day,
      concurrent_requests === undefined ? (current?.concurrent_requests ?? null) : concurrent_requests,
    ],
    conn,
  );
}
const languageSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z
    .string()
    .trim()
    .max(16)
    .transform((value, context) => {
      try {
        return Intl.getCanonicalLocales(value)[0];
      } catch {
        context.addIssue({ code: 'custom', message: 'Enter a language code such as fr-FR or zh-Hans' });
        return z.NEVER;
      }
    }),
});
const domainSchema = z
  .object({
    hostname: z
      .string()
      .trim()
      .max(253)
      .transform(normalizeHost)
      .pipe(
        z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
      ),
    origin: z.url({ protocol: /^https?$/ }).max(350),
    language_id: idSchema,
    group_id: idSchema,
    daily_limit: z.number().int().min(0).max(10000).nullable(),
    timezone: z
      .string()
      .max(80)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    enabled: z.boolean(),
    sitemap_enabled: z.boolean(),
    rss_enabled: z.boolean(),
    manual_approval: z.boolean(),
  })
  .refine((value) => {
    const url = URL.parse(value.origin);
    return (
      url !== null &&
      url.origin === value.origin &&
      normalizeHost(url.hostname) === value.hostname &&
      (!production || url.protocol === 'https:')
    );
  }, 'Use an origin matching the configured hostname');
const domainRoutingSchema = z
  .object({
    provider_id: idSchema.nullable().optional(),
    fallback_provider_id: idSchema.nullable().optional(),
    priority: z.number().int().min(1).max(32767).nullable().optional(),
  })
  .refine(
    (domain) => !domain.provider_id || domain.provider_id !== domain.fallback_provider_id,
    'Choose a different fallback provider',
  );

async function saveDomainRouting(
  conn: PoolConnection,
  domainId: number,
  routing: z.infer<typeof domainRoutingSchema>,
) {
  if (Object.keys(routing).length === 0) return;
  const [saved] = await rows<{
    provider_id: number | null;
    fallback_provider_id: number | null;
    priority: number | null;
  }>(
    'SELECT provider_id,fallback_provider_id,priority FROM domain_routing WHERE domain_id=?',
    [domainId],
    conn,
  );
  const result = parse(domainRoutingSchema, { ...saved, ...routing });
  await execute(
    `INSERT INTO domain_routing (domain_id,provider_id,fallback_provider_id,priority) VALUES (?,?,?,?)
      AS incoming ON DUPLICATE KEY UPDATE provider_id=incoming.provider_id,
      fallback_provider_id=incoming.fallback_provider_id,priority=incoming.priority`,
    [domainId, result.provider_id ?? null, result.fallback_provider_id ?? null, result.priority ?? null],
    conn,
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const data = schema.safeParse(value);
  if (!data.success)
    throw new BadRequestException(
      data.error.issues.map((issue) => [issue.path.join('.'), issue.message].filter(Boolean).join(' ')),
    );
  return data.data;
}

const lists = {
  articles:
    "SELECT id,source_post_id,title,category,content_type,status,published_at,modified_at FROM articles WHERE (title LIKE ? OR source_post_id LIKE ?) AND (?='' OR status=?) ORDER BY id DESC",
  jobs: `SELECT j.id,a.title,d.hostname,l.name language,p.name provider,j.state,j.error_code,j.created_at FROM translation_jobs j
    JOIN articles a ON a.id=j.article_id JOIN domains d ON d.id=j.domain_id JOIN languages l ON l.id=d.language_id JOIN translation_providers p ON p.id=j.provider_id
    WHERE (a.title LIKE ? OR CAST(j.id AS CHAR) LIKE ?) AND (?='' OR j.state=?) ORDER BY j.id DESC`,
  domains: `SELECT d.*, l.name language,l.code,g.name group_name,p.name provider,r.provider_id,r.fallback_provider_id,r.priority,
      COALESCE(d.daily_limit,g.daily_limit) effective_limit FROM domains d
    JOIN languages l ON l.id=d.language_id JOIN translation_groups g ON g.id=d.group_id
    LEFT JOIN domain_routing r ON r.domain_id=d.id JOIN translation_providers p ON p.id=COALESCE(r.provider_id,g.provider_id)
    WHERE (d.hostname LIKE ? OR l.name LIKE ?) AND (?='' OR d.enabled=?) ORDER BY d.id`,
  groups: `SELECT g.*,p.name provider,f.name fallback,(SELECT COUNT(*) FROM domains WHERE group_id=g.id) domains
    FROM translation_groups g JOIN translation_providers p ON p.id=g.provider_id LEFT JOIN translation_providers f ON f.id=g.fallback_provider_id
    WHERE (g.name LIKE ? OR p.name LIKE ?) AND (?='' OR g.enabled=?) ORDER BY g.priority,g.id`,
  providers: `SELECT p.id,p.name,p.adapter,p.model,p.enabled,p.cost_inr_per_million,
    policy.requests_per_minute,policy.requests_per_day,policy.concurrent_requests,
    EXISTS(SELECT 1 FROM provider_credentials c WHERE c.provider_id=p.id) has_stored_key
    FROM translation_providers p LEFT JOIN provider_policies policy ON policy.provider_id=p.id
    WHERE (p.name LIKE ? OR p.adapter LIKE ?) AND (?='' OR p.enabled=?) ORDER BY p.id`,
  languages:
    "SELECT id,name,code FROM languages WHERE (name LIKE ? OR code LIKE ?) AND (?='' OR code=?) ORDER BY name",
  memory:
    "SELECT source_hash,source_language,target_language,provider_id,LEFT(translated_text,160) sample,created_at FROM translation_memory WHERE (source_language LIKE ? OR target_language LIKE ?) AND (?='' OR target_language=?) ORDER BY created_at DESC",
  users:
    "SELECT id,email,role,enabled FROM users WHERE (email LIKE ? OR role LIKE ?) AND (?='' OR role=?) ORDER BY id",
  redirects:
    "SELECT r.domain_id,d.hostname,r.old_path,r.new_path FROM redirects r JOIN domains d ON d.id=r.domain_id WHERE (r.old_path LIKE ? OR d.hostname LIKE ?) AND (?='' OR d.hostname=?) ORDER BY d.id",
  logs: "SELECT request_id,article_id,created_at FROM webhook_logs WHERE (request_id LIKE ? OR CAST(article_id AS CHAR) LIKE ?) AND (?='' OR CAST(article_id AS CHAR)=?) ORDER BY created_at DESC",
  activity: `SELECT a.id,u.email,a.method,a.path,a.status,a.created_at FROM admin_activity a JOIN users u ON u.id=a.user_id
    WHERE (u.email LIKE ? OR a.path LIKE ?) AND (?='' OR CAST(a.status AS CHAR)=?) ORDER BY a.id DESC`,
  taxonomy:
    "SELECT category,COUNT(*) articles FROM articles WHERE (category LIKE ? OR title LIKE ?) AND (?='' OR category=?) GROUP BY category ORDER BY articles DESC",
} as const;

@Controller('api/v1')
export class AdminController {
  @Get('overview')
  async overview(@Req() request: Request, @Query('days') daysParam?: string) {
    await authorize(request);
    const days = [7, 30, 90].includes(Number(daysParam)) ? Number(daysParam) : 30;
    const since = new Date(Date.now() - days * 86_400_000);
    const [articles, jobs, domains, usage, groups, recent, activity, heartbeat] = await Promise.all([
      rows('SELECT COUNT(*) total FROM articles WHERE published_at>=?', [since]),
      rows('SELECT state,COUNT(*) total FROM translation_jobs WHERE created_at>=? GROUP BY state', [since]),
      rows('SELECT COUNT(*) total FROM domains WHERE enabled=1'),
      rows(
        `SELECT p.name,p.adapter,COUNT(u.id) requests,COALESCE(SUM(u.characters),0) characters,
        COALESCE(SUM(u.cost_inr),0) cost,COALESCE(SUM(u.success=0),0) failures,COALESCE(SUM(u.is_fallback),0) fallbacks
        FROM translation_providers p LEFT JOIN provider_usage u ON p.id=u.provider_id AND u.created_at>=? GROUP BY p.id,p.name,p.adapter ORDER BY cost DESC`,
        [since],
      ),
      rows(lists.groups + ' LIMIT 20', ['%', '%', '', '']),
      rows(lists.jobs + ' LIMIT 5', ['%', '%', '', '']),
      rows(
        `SELECT day,SUM(articles) articles,SUM(jobs) jobs FROM (
        SELECT DATE_FORMAT(published_at,'%Y-%m-%d') day,COUNT(*) articles,0 jobs FROM articles WHERE published_at>=? GROUP BY day
        UNION ALL SELECT DATE_FORMAT(created_at,'%Y-%m-%d'),0,COUNT(*) FROM translation_jobs WHERE created_at>=? GROUP BY 1
        ) timeline GROUP BY day ORDER BY day`,
        [since, since],
      ),
      monitoring
        .get('ttw:worker:heartbeat')
        .then((value) => ({ redis: true, worker: Boolean(value) }))
        .catch(() => ({ redis: false, worker: false })),
    ]);
    return {
      articles: articles[0],
      domains: domains[0],
      jobs,
      usage,
      groups,
      recent,
      activity,
      health: { ...heartbeat, api: true, mysql: true },
    };
  }

  @Get('catalog/:resource')
  async catalog(
    @Req() request: Request,
    @Param('resource') resource: string,
    @Query('q') query = '',
    @Query('status') status = '',
    @Query('page') page = '1',
  ) {
    await authorize(request, ['users', 'activity'].includes(resource) ? accountManagers : undefined);
    if (!Object.hasOwn(lists, resource)) throw new NotFoundException();
    const sql = lists[resource as keyof typeof lists];
    const term = '%' + query.slice(0, 120) + '%';
    const offset = Math.max(0, Math.min(100_000, (Number.parseInt(page) - 1) * 25 || 0));
    const data = await rows(sql + ' LIMIT 26 OFFSET ' + offset, [
      term,
      term,
      status.slice(0, 60),
      status.slice(0, 60),
    ]);
    return { items: data.slice(0, 25), more: data.length > 25 };
  }

  @Get('articles/:id')
  async article(@Req() request: Request, @Param('id') value: string) {
    await authorize(request);
    const id = parse(idSchema, value);
    const [source] = await rows(
      `SELECT a.id,a.title,a.status,a.source_post_id,a.published_at,a.modified_at,a.current_hash,v.payload
      FROM articles a JOIN article_versions v ON v.article_id=a.id AND v.source_hash=a.current_hash WHERE a.id=?`,
      [id],
    );
    if (!source) throw new NotFoundException();
    const translations = await rows(
      `SELECT t.id,t.title,t.slug,t.state,t.updated_at,d.hostname,d.origin,l.name language
      FROM article_translations t JOIN domains d ON d.id=t.domain_id JOIN languages l ON l.id=d.language_id
      WHERE t.article_id=? ORDER BY t.id DESC LIMIT 150`,
      [id],
    );
    const jobs = await rows(
      `SELECT j.id,j.state,j.error_code,j.created_at,d.hostname,p.name provider
      FROM translation_jobs j JOIN domains d ON d.id=j.domain_id JOIN translation_providers p ON p.id=j.provider_id
      WHERE j.article_id=? ORDER BY j.id DESC LIMIT 150`,
      [id],
    );
    return { source, translations, jobs };
  }

  @Post(['articles/:id/translate', 'articles/:id/redistribute'])
  async manual(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    await authorize(request, editors);
    const id = parse(idSchema, value);
    const target = parse(z.object({ domainId: idSchema.optional() }), body).domainId;
    const created = await transaction(async (conn) => {
      const [source] = await rows<{ current_hash: string; payload: Article }>(
        `SELECT a.current_hash,v.payload FROM articles a
        JOIN article_versions v ON v.article_id=a.id AND v.source_hash=a.current_hash WHERE a.id=? AND a.status='publish' FOR UPDATE`,
        [id],
        conn,
      );
      if (!source) throw new NotFoundException();
      return distribute(conn, id, source.current_hash, source.payload, target);
    });
    return { created };
  }

  @Patch('jobs/:id')
  async job(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    await authorize(request, editors);
    const id = parse(idSchema, value);
    const { action } = parse(z.object({ action: z.enum(['retry', 'cancel', 'approve', 'unpublish']) }), body);
    if (action === 'retry' || action === 'cancel') {
      const result =
        action === 'retry'
          ? await execute(
              "UPDATE translation_jobs SET state='pending',generation=generation+1,error_code=NULL WHERE id=? AND state IN ('failed','cancelled','skipped')",
              [id],
            )
          : await execute(
              "UPDATE translation_jobs SET state='cancelled' WHERE id=? AND state IN ('pending','processing','retrying')",
              [id],
            );
      return { changed: Boolean(result.affectedRows) };
    }
    return transaction(async (conn) => {
      const [link] = await rows<{ article_id: number }>(
        'SELECT article_id FROM translation_jobs WHERE id=?',
        [id],
        conn,
      );
      if (!link) throw new NotFoundException();
      await rows('SELECT id FROM articles WHERE id=? FOR UPDATE', [link.article_id], conn);
      const [job] = await rows<{ domain_id: number; state: string; eligible: number }>(
        `SELECT j.domain_id,j.state,
        (d.enabled AND g.enabled AND a.status='publish' AND a.current_hash=j.source_hash) eligible
        FROM translation_jobs j JOIN articles a ON a.id=j.article_id JOIN domains d ON d.id=j.domain_id
        JOIN translation_groups g ON g.id=d.group_id WHERE j.id=? FOR UPDATE`,
        [id],
        conn,
      );
      if (action === 'approve' && job.state === 'review' && job.eligible) {
        const [translation] = await rows<{ id: number }>(
          "SELECT id FROM article_translations WHERE job_id=? AND state='review'",
          [id],
          conn,
        );
        if (!translation) return { changed: false };
        await execute(
          "UPDATE article_translations SET state='archived' WHERE article_id=? AND domain_id=? AND state='published'",
          [link.article_id, job.domain_id],
          conn,
        );
        await execute("UPDATE article_translations SET state='published' WHERE job_id=?", [id], conn);
        await execute("UPDATE translation_jobs SET state='published' WHERE id=?", [id], conn);
        await refreshWebsiteCache(job.domain_id, conn);
        return { changed: true };
      }
      if (action === 'unpublish' && job.state === 'published') {
        const result = await execute(
          "UPDATE article_translations SET state='archived' WHERE job_id=? AND state='published'",
          [id],
          conn,
        );
        if (result.affectedRows) {
          await execute("UPDATE translation_jobs SET state='cancelled' WHERE id=?", [id], conn);
          await refreshWebsiteCache(job.domain_id, conn);
        }
        return { changed: Boolean(result.affectedRows) };
      }
      return { changed: false };
    });
  }

  @Post('languages')
  async addLanguage(@Req() request: Request, @Body() body: unknown) {
    await authorize(request, domainManagers);
    const { name, code } = parse(languageSchema, body);
    try {
      const result = await execute('INSERT INTO languages (name,code) VALUES (?,?)', [name, code]);
      return { id: result.insertId, name, code };
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new ConflictException('This language code is already registered');
      }
      throw error;
    }
  }

  @Get('domain-options')
  async domainOptions(@Req() request: Request) {
    await authorize(request, domainManagers);
    const [languages, groups, providers] = await Promise.all([
      rows('SELECT id,name,code FROM languages ORDER BY name,code'),
      rows(`SELECT g.id,g.name,g.daily_limit,p.name provider FROM translation_groups g
        JOIN translation_providers p ON p.id=g.provider_id ORDER BY g.name`),
      rows('SELECT id,name FROM translation_providers ORDER BY name'),
    ]);
    return { languages, groups, providers };
  }

  @Get('distribution/rules')
  async distributionRules(@Req() request: Request) {
    await authorize(request, managers);
    const [rules, domains, groups, providers, categories] = await Promise.all([
      rows(`SELECT r.*,COALESCE(a.used,0) used FROM distribution_rules r
        LEFT JOIN distribution_allocations a ON a.rule_id=r.id AND a.utc_day=UTC_DATE()
        ORDER BY r.priority,r.id`),
      rows('SELECT id,hostname name FROM domains ORDER BY hostname'),
      rows('SELECT id,name FROM translation_groups ORDER BY name'),
      rows('SELECT id,name FROM translation_providers ORDER BY name'),
      rows(`SELECT CONVERT(name USING utf8mb4) COLLATE utf8mb4_0900_ai_ci AS name FROM wordpress_categories UNION DISTINCT
        SELECT CONVERT(c.name USING utf8mb4) COLLATE utf8mb4_0900_ai_ci
        FROM articles a JOIN article_versions v ON v.article_id=a.id AND v.source_hash=a.current_hash
        CROSS JOIN JSON_TABLE(v.payload,'$.categories[*]' COLUMNS(name VARCHAR(200) PATH '$')) c ORDER BY name LIMIT 5000`),
    ]);
    return { rules, domains, groups, providers, categories };
  }

  @Get('distribution/usage')
  async distributionUsage(@Req() request: Request) {
    await authorize(request, managers);
    const date = new Date();
    const day = (offset: number) => new Date(date.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
    const [domains, allocations, statuses] = await Promise.all([
      rows<{
        id: number;
        hostname: string;
        timezone: string;
        daily_limit: number;
      }>(`SELECT d.id,d.hostname,d.timezone,
        COALESCE(d.daily_limit,g.daily_limit) daily_limit FROM domains d JOIN translation_groups g ON g.id=d.group_id
        WHERE d.enabled=1 AND g.enabled=1 ORDER BY d.hostname`),
      rows<{ domain_id: number; local_day: string; used: number }>(
        `SELECT domain_id,DATE_FORMAT(local_day,'%Y-%m-%d') local_day,used
        FROM daily_allocations WHERE local_day BETWEEN ? AND ?`,
        [day(-1), day(1)],
      ),
      rows<{
        domain_id: number;
        published: number;
        failed: number;
      }>(`SELECT domain_id,SUM(state='published') published,SUM(state='failed') failed
        FROM translation_jobs WHERE created_at >= UTC_DATE() GROUP BY domain_id`),
    ]);
    const usage = new Map(allocations.map((row) => [`${row.domain_id}:${row.local_day}`, row.used]));
    const totals = new Map(statuses.map((row) => [row.domain_id, row]));
    return domains.map((domain) => {
      const local_day = localDay(date, domain.timezone);
      const used = usage.get(`${domain.id}:${local_day}`) ?? 0;
      const status = totals.get(domain.id);
      return {
        ...domain,
        local_day,
        used,
        remaining: Math.max(0, domain.daily_limit - used),
        published: Number(status?.published ?? 0),
        failed: Number(status?.failed ?? 0),
      };
    });
  }

  @Post('distribution/rules')
  async addRule(@Req() request: Request, @Body() body: unknown) {
    await authorize(request, managers);
    const rule = parse(ruleSchema, body);
    await checkRuleTargets(rule);
    const created = await execute(
      `INSERT INTO distribution_rules
      (category,group_id,domain_id,daily_limit,priority,provider_id,fallback_provider_id,enabled)
      VALUES (?,?,?,?,?,?,?,?)`,
      Object.values(rule),
    );
    return { id: created.insertId };
  }

  @Patch('distribution/rules/:id')
  async editRule(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    await authorize(request, managers);
    const rule = parse(ruleSchema, body);
    await checkRuleTargets(rule);
    const updated = await execute(
      `UPDATE distribution_rules SET category=?,group_id=?,domain_id=?,daily_limit=?,priority=?,
      provider_id=?,fallback_provider_id=?,enabled=? WHERE id=?`,
      [...Object.values(rule), parse(idSchema, value)],
    );
    if (!updated.affectedRows) throw new NotFoundException();
    return { changed: true };
  }

  @Get('website')
  async website(@Req() request: Request) {
    await authorize(request, siteManagers);
    const [[current], versions, domains, languages, overrides, translations] = await Promise.all([
      rows<{ published_version: number | null }>('SELECT published_version FROM website_settings WHERE id=1'),
      rows('SELECT id,created_at FROM website_versions ORDER BY id DESC LIMIT 100'),
      rows('SELECT id,hostname name,language_id,origin FROM domains ORDER BY hostname'),
      rows('SELECT id,name,code FROM languages ORDER BY name'),
      rows('SELECT domain_id,configuration FROM website_domain_overrides'),
      rows('SELECT language_id,translations FROM static_translations'),
    ]);
    const [published] = current.published_version
      ? await rows<{ configuration: unknown }>('SELECT configuration FROM website_versions WHERE id=?', [
          current.published_version,
        ])
      : [];
    return {
      publishedVersion: current.published_version,
      design: published?.configuration ?? defaultWebsite,
      versions,
      domains,
      languages,
      overrides,
      translations,
    };
  }

  @Get('website/versions/:id')
  async version(@Req() request: Request, @Param('id') value: string) {
    await authorize(request, siteManagers);
    const [version] = await rows('SELECT id,configuration FROM website_versions WHERE id=?', [
      parse(idSchema, value),
    ]);
    if (!version) throw new NotFoundException();
    return version;
  }

  @Post('website/versions')
  async saveVersion(@Req() request: Request, @Body() body: unknown) {
    await authorize(request, siteManagers);
    const design = parse(websiteSchema, body);
    const result = await execute('INSERT INTO website_versions (configuration) VALUES (?)', [
      JSON.stringify(design),
    ]);
    return { id: result.insertId };
  }

  @Post('website/versions/:id/publish')
  async publishVersion(@Req() request: Request, @Param('id') value: string) {
    await authorize(request, siteManagers);
    const id = parse(idSchema, value);
    const [version] = await rows('SELECT id FROM website_versions WHERE id=?', [id]);
    if (!version) throw new NotFoundException();
    await transaction(async (conn) => {
      await execute('UPDATE website_settings SET published_version=? WHERE id=1', [id], conn);
      await refreshWebsiteCache(0, conn);
    });
    return { id };
  }

  @Put('website/overrides/:id')
  async saveOverride(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    await authorize(request, siteManagers);
    const id = parse(idSchema, value);
    if (!(await rows('SELECT id FROM domains WHERE id=?', [id])).length) throw new NotFoundException();
    const design = parse(overrideSchema, body);
    await transaction(async (conn) => {
      await execute(
        `INSERT INTO website_domain_overrides (domain_id,configuration) VALUES (?,?)
        AS incoming ON DUPLICATE KEY UPDATE configuration=incoming.configuration`,
        [id, JSON.stringify(design)],
        conn,
      );
      await refreshWebsiteCache(id, conn);
    });
    return { id };
  }

  @Put('website/translations/:id')
  async saveLabels(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    await authorize(request, siteManagers);
    const id = parse(idSchema, value);
    if (!(await rows('SELECT id FROM languages WHERE id=?', [id])).length) throw new NotFoundException();
    const labels = parse(localizationSchema, body);
    await transaction(async (conn) => {
      await execute(
        `INSERT INTO static_translations (language_id,translations) VALUES (?,?)
        AS incoming ON DUPLICATE KEY UPDATE translations=incoming.translations`,
        [id, JSON.stringify(labels)],
        conn,
      );
      const domains = await rows<{ id: number }>(
        'SELECT id FROM domains WHERE language_id=? ORDER BY id',
        [id],
        conn,
      );
      for (const domain of domains) await refreshWebsiteCache(domain.id, conn);
    });
    return { id };
  }

  @Post('domains')
  async addDomain(@Req() request: Request, @Body() body: unknown) {
    await authorize(request, domainManagers);
    const domain = parse(domainSchema, body);
    const routing = parse(domainRoutingSchema, body);
    return transaction(async (conn) => {
      const result = await execute(
        `INSERT INTO domains
        (hostname,origin,language_id,group_id,daily_limit,timezone,enabled,sitemap_enabled,rss_enabled,manual_approval)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        Object.values(domain),
        conn,
      );
      await saveDomainRouting(conn, result.insertId, routing);
      await refreshWebsiteCache(0, conn);
      return { id: result.insertId };
    });
  }

  @Patch('domains/:id')
  async editDomain(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    await authorize(request, domainManagers);
    const id = parse(idSchema, value);
    const domain = parse(domainSchema, body);
    const routing = parse(domainRoutingSchema, body);
    return transaction(async (conn) => {
      const [current] = await rows<{ language_id: number }>(
        'SELECT language_id FROM domains WHERE id=? FOR UPDATE',
        [id],
        conn,
      );
      if (!current) throw new NotFoundException();
      if (current.language_id !== domain.language_id) {
        const [job] = await rows('SELECT id FROM translation_jobs WHERE domain_id=? LIMIT 1', [id], conn);
        if (job)
          throw new ConflictException(
            'Create a new domain for a different language when translation jobs already exist',
          );
      }
      const result = await execute(
        `UPDATE domains SET hostname=?,origin=?,language_id=?,group_id=?,daily_limit=?,timezone=?,
        enabled=?,sitemap_enabled=?,rss_enabled=?,manual_approval=? WHERE id=?`,
        [...Object.values(domain), id],
        conn,
      );
      await saveDomainRouting(conn, id, routing);
      await refreshWebsiteCache(0, conn);
      return { changed: Boolean(result.affectedRows) };
    });
  }

  @Post('groups')
  async addGroup(@Req() request: Request, @Body() body: unknown) {
    await authorize(request, managers);
    const group = parse(groupSchema, body);
    const result = await execute(
      `INSERT INTO translation_groups
      (name,description,daily_limit,priority,enabled,provider_id,fallback_provider_id) VALUES (?,?,?,?,?,?,?)`,
      Object.values(group),
    );
    return { id: result.insertId };
  }

  @Post('users')
  async createUser(@Req() request: Request, @Body() body: unknown) {
    const actor = await authorize(request, accountManagers);
    const user = parse(userSchema.required({ password: true }), body);
    if (actor.role !== 'super_admin' && accountManagers.includes(user.role)) throw new ForbiddenException();
    const result = await execute(
      'INSERT IGNORE INTO users (email,password_hash,role,enabled) VALUES (?,?,?,?)',
      [user.email, passwordHash(user.password), user.role, user.enabled],
    );
    if (!result.affectedRows) throw new ConflictException('An account already uses this email');
    return { id: result.insertId };
  }

  @Patch('users/:id')
  async updateUser(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    const actor = await authorize(request, accountManagers);
    const id = parse(idSchema, value);
    const user = parse(userSchema, body);
    const hash = user.password ? passwordHash(user.password) : null;
    return transaction(async (conn) => {
      const locked = await rows<{ id: number; role: string; enabled: number }>(
        'SELECT id,role,enabled FROM users WHERE id IN (?,?) ORDER BY id FOR UPDATE',
        [actor.id, id],
        conn,
      );
      const currentActor = locked.find((item) => item.id === actor.id);
      const target = locked.find((item) => item.id === id);
      if (!currentActor?.enabled || !accountManagers.includes(currentActor.role))
        throw new ForbiddenException();
      if (!target) throw new NotFoundException();
      if (id === actor.id && (!user.enabled || user.role !== currentActor.role))
        throw new ConflictException('Your own account must remain active with its current role');
      if (
        id !== actor.id &&
        currentActor.role !== 'super_admin' &&
        (accountManagers.includes(target.role) || accountManagers.includes(user.role))
      )
        throw new ForbiddenException();
      try {
        await execute(
          'UPDATE users SET email=?,role=?,enabled=?,password_hash=COALESCE(?,password_hash) WHERE id=?',
          [user.email, user.role, user.enabled, hash, id],
          conn,
        );
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
          throw new ConflictException('An account already uses this email');
        throw error;
      }
      return { id };
    });
  }

  @Patch('groups/:id')
  async editGroup(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    await authorize(request, managers);
    const id = parse(idSchema, value);
    const group = parse(groupSchema, body);
    const result = await execute(
      `UPDATE translation_groups SET name=?,description=?,daily_limit=?,priority=?,enabled=?,
      provider_id=?,fallback_provider_id=? WHERE id=?`,
      [...Object.values(group), id],
    );
    return { changed: Boolean(result.affectedRows) };
  }

  @Post('providers')
  async addProvider(@Req() request: Request, @Body() body: unknown) {
    await authorize(request, ['super_admin', 'admin']);
    const provider = parse(createProviderSchema, body);
    const defaultModel = providerCatalog[provider.adapter].defaultModel;
    if (provider.model && !defaultModel)
      throw new BadRequestException('This provider uses its built-in translation model');
    try {
      return await transaction(async (conn) => {
        const result = await execute(
          'INSERT INTO translation_providers (name,adapter,model,enabled,cost_inr_per_million) VALUES (?,?,?,?,?)',
          [
            provider.name,
            provider.adapter,
            provider.model ?? defaultModel,
            provider.enabled,
            provider.cost_inr_per_million,
          ],
          conn,
        );
        if (provider.api_key) await saveProviderKey(conn, result.insertId, provider.api_key);
        await saveProviderLimits(conn, result.insertId, provider);
        return { id: result.insertId };
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
        throw new ConflictException('This provider name is already registered');
      throw error;
    }
  }

  @Post('providers/test')
  async testProvider(@Req() request: Request, @Body() body: unknown) {
    await authorize(request, managers);
    const { id, target } = parse(
      z.object({
        id: idSchema,
        target: z
          .string()
          .regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)
          .max(16)
          .default('fr'),
      }),
      body,
    );
    const [provider] = await rows<
      ProviderLimits & { adapter: string; model: string | null; encrypted_key: string | null }
    >(
      `SELECT p.adapter,p.model,c.encrypted_key,policy.requests_per_minute,policy.requests_per_day,policy.concurrent_requests
       FROM translation_providers p LEFT JOIN provider_credentials c ON c.provider_id=p.id
       LEFT JOIN provider_policies policy ON policy.provider_id=p.id WHERE p.id=?`,
      [id],
    );
    if (!provider) throw new NotFoundException();
    const adapter = adapters[provider.adapter];
    if (!adapter) return { connected: false, code: 'provider_unavailable' };
    const available = await monitoring.set('ttw:provider-test:' + id, '1', 'EX', 10, 'NX');
    if (!available) return { connected: false, code: 'test_recently_requested' };
    try {
      const encryptionKey = providerCredentialEncryptionKey();
      if (provider.encrypted_key && !encryptionKey)
        return { connected: false, code: 'credential_key_missing' };
      const credential =
        provider.encrypted_key && encryptionKey
          ? decryptProviderCredential(provider.encrypted_key, encryptionKey, id)
          : undefined;
      if (!adapter.validateConfiguration(credential))
        return { connected: false, code: 'provider_unconfigured' };
      const release = await reserveProviderRequest(monitoring, id, provider);
      if (!release) return { connected: false, code: 'provider_request_limit' };
      try {
        await adapter.translate(
          { text: ['Travel and tourism'], source: 'en', target },
          credential,
          provider.model ?? undefined,
        );
      } finally {
        await release();
      }
      return { connected: true };
    } catch (error) {
      return {
        connected: false,
        code: error instanceof ProviderError ? error.code : 'credential_unreadable',
      };
    }
  }

  @Patch('providers/:id')
  async editProvider(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    const user = await authorize(request, managers);
    const id = parse(idSchema, value);
    const provider = parse(providerSchema, body);
    if (provider.api_key && !['super_admin', 'admin'].includes(user.role)) {
      throw new ForbiddenException('Admin role required to save provider credentials');
    }
    return transaction(async (conn) => {
      const [existing] = await rows<{ adapter: string }>(
        'SELECT adapter FROM translation_providers WHERE id=? FOR UPDATE',
        [id],
        conn,
      );
      if (!existing) throw new NotFoundException();
      const adapter = existing.adapter;
      const supported = isProviderKind(adapter);
      if (provider.model && (!supported || !providerCatalog[adapter].defaultModel))
        throw new BadRequestException('This provider uses its built-in translation model');
      if (provider.api_key && !supported)
        throw new BadRequestException('This provider does not use an API key');
      if (provider.api_key) await saveProviderKey(conn, id, provider.api_key);
      await saveProviderLimits(conn, id, provider);
      await execute(
        'UPDATE translation_providers SET enabled=?,cost_inr_per_million=?,model=COALESCE(?,model) WHERE id=?',
        [provider.enabled, provider.cost_inr_per_million, provider.model ?? null, id],
        conn,
      );
      return { changed: true };
    });
  }
}
