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
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { execute, rows, transaction } from '../../../packages/database/src/db';
import { Article, normalizeHost } from '../../../packages/shared/src/article';
import { production, secret } from '../../../packages/shared/src/config';
import { redis } from '../../../packages/shared/src/queue';
import { distribute } from './ingest';

export type ApiRequest = Request & { rawBody?: Buffer };
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
  if (roles && !roles.includes(user.role)) throw new ForbiddenException('Insufficient permission');
  return user;
}

const managers = ['super_admin', 'admin', 'translation_manager'];
const editors = [...managers, 'editor'];
const idSchema = z.coerce.number().int().positive().max(4_294_967_295);
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
  cost_inr_per_million: z.number().min(0).max(9_999_999),
});
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
    const url = new URL(value.origin);
    return (
      url.origin === value.origin &&
      normalizeHost(url.hostname) === value.hostname &&
      (!production || url.protocol === 'https:')
    );
  }, 'Use an origin matching the configured hostname');

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
    "SELECT id,source_post_id,title,category,status,published_at,modified_at FROM articles WHERE (title LIKE ? OR source_post_id LIKE ?) AND (?='' OR status=?) ORDER BY id DESC",
  jobs: `SELECT j.id,a.title,d.hostname,l.name language,p.name provider,j.state,j.error_code,j.created_at FROM translation_jobs j
    JOIN articles a ON a.id=j.article_id JOIN domains d ON d.id=j.domain_id JOIN languages l ON l.id=d.language_id JOIN translation_providers p ON p.id=j.provider_id
    WHERE (a.title LIKE ? OR CAST(j.id AS CHAR) LIKE ?) AND (?='' OR j.state=?) ORDER BY j.id DESC`,
  domains: `SELECT d.*, l.name language,l.code,g.name group_name,p.name provider,COALESCE(d.daily_limit,g.daily_limit) effective_limit FROM domains d
    JOIN languages l ON l.id=d.language_id JOIN translation_groups g ON g.id=d.group_id JOIN translation_providers p ON p.id=g.provider_id
    WHERE (d.hostname LIKE ? OR l.name LIKE ?) AND (?='' OR d.enabled=?) ORDER BY d.id`,
  groups: `SELECT g.*,p.name provider,f.name fallback,(SELECT COUNT(*) FROM domains WHERE group_id=g.id) domains
    FROM translation_groups g JOIN translation_providers p ON p.id=g.provider_id LEFT JOIN translation_providers f ON f.id=g.fallback_provider_id
    WHERE (g.name LIKE ? OR p.name LIKE ?) AND (?='' OR g.enabled=?) ORDER BY g.priority,g.id`,
  providers:
    "SELECT id,name,adapter,enabled,cost_inr_per_million FROM translation_providers WHERE (name LIKE ? OR adapter LIKE ?) AND (?='' OR enabled=?) ORDER BY id",
  languages:
    "SELECT id,name,code FROM languages WHERE (name LIKE ? OR code LIKE ?) AND (?='' OR code=?) ORDER BY name",
  memory:
    "SELECT source_hash,source_language,target_language,provider_id,LEFT(translated_text,160) sample,created_at FROM translation_memory WHERE (source_language LIKE ? OR target_language LIKE ?) AND (?='' OR target_language=?) ORDER BY created_at DESC",
  users:
    "SELECT id,email,role,enabled FROM users WHERE (email LIKE ? OR role LIKE ?) AND (?='' OR role=?) ORDER BY id",
  redirects:
    "SELECT r.domain_id,d.hostname,r.old_path,r.new_path FROM redirects r JOIN domains d ON d.id=r.domain_id WHERE (r.old_path LIKE ? OR d.hostname LIKE ?) AND (?='' OR d.hostname=?) ORDER BY d.id",
  logs: "SELECT request_id,article_id,created_at FROM webhook_logs WHERE (request_id LIKE ? OR CAST(article_id AS CHAR) LIKE ?) AND (?='' OR CAST(article_id AS CHAR)=?) ORDER BY created_at DESC",
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
    await authorize(request, resource === 'users' ? ['super_admin', 'admin'] : undefined);
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

  @Post('articles/:id/translate')
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
      return distribute(conn, id, source.current_hash, source.payload.language, target);
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
        return { changed: true };
      }
      if (action === 'unpublish' && job.state === 'published') {
        const result = await execute(
          "UPDATE article_translations SET state='archived' WHERE job_id=? AND state='published'",
          [id],
          conn,
        );
        if (result.affectedRows)
          await execute("UPDATE translation_jobs SET state='cancelled' WHERE id=?", [id], conn);
        return { changed: Boolean(result.affectedRows) };
      }
      return { changed: false };
    });
  }

  @Post('languages')
  async addLanguage(@Req() request: Request, @Body() body: unknown) {
    await authorize(request, managers);
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
    await authorize(request, managers);
    const [languages, groups] = await Promise.all([
      rows('SELECT id,name,code FROM languages ORDER BY name,code'),
      rows(`SELECT g.id,g.name,g.daily_limit,p.name provider FROM translation_groups g
        JOIN translation_providers p ON p.id=g.provider_id ORDER BY g.name`),
    ]);
    return { languages, groups };
  }

  @Post('domains')
  async addDomain(@Req() request: Request, @Body() body: unknown) {
    await authorize(request, managers);
    const domain = parse(domainSchema, body);
    const result = await execute(
      `INSERT INTO domains
      (hostname,origin,language_id,group_id,daily_limit,timezone,enabled,sitemap_enabled,rss_enabled,manual_approval)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      Object.values(domain),
    );
    return { id: result.insertId };
  }

  @Patch('domains/:id')
  async editDomain(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    await authorize(request, managers);
    const id = parse(idSchema, value);
    const domain = parse(domainSchema, body);
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

  @Patch('providers/:id')
  async editProvider(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    await authorize(request, managers);
    const id = parse(idSchema, value);
    const provider = parse(providerSchema, body);
    const result = await execute(
      'UPDATE translation_providers SET enabled=?,cost_inr_per_million=? WHERE id=?',
      [provider.enabled, provider.cost_inr_per_million, id],
    );
    return { changed: Boolean(result.affectedRows) };
  }
}
