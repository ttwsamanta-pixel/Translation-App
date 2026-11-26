import 'reflect-metadata';
import {
  Controller,
  Get,
  HttpCode,
  Module,
  Post,
  Req,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  HttpException,
  Res,
  Body,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, Request, Response } from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { database, execute, rows, transaction } from '../../../packages/database/src/db';
import { articleSchema, normalizeHost, sha256 } from '../../../packages/shared/src/article';
import { passwordHash, safeEqual, validPassword, verifyWebhook } from '../../../packages/shared/src/auth';
import { required, secret } from '../../../packages/shared/src/config';
import { redis } from '../../../packages/shared/src/queue';
import { ingest, storeArticle } from './ingest';
import { AdminController, ApiRequest, users } from './management';

const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(250) });
const dummyHash = passwordHash('unused-credential');
const rate = redis();
rate.on('error', (error) => console.error(JSON.stringify({ event: 'redis_error', type: error.name })));
const rateScript =
  "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n";

async function throttle(req: Request, key: string, max: number) {
  const count = await rate.eval(rateScript, 1, `ttw:rate:${key}:${req.ip}`, 60);
  if (Number(count) > max) throw new HttpException('Too many requests', 429);
}

async function authenticateWebhook(request: ApiRequest) {
  await throttle(request, 'webhook', 450);
  const requestId = request.get('x-request-id') ?? '';
  const raw = request.rawBody;
  if (
    !raw ||
    !safeEqual(request.get('x-api-key') ?? '', secret('WEBHOOK_API_KEY')) ||
    !verifyWebhook(
      raw,
      request.get('x-timestamp') ?? '',
      requestId,
      request.get('x-signature') ?? '',
      secret('WEBHOOK_SECRET'),
    )
  )
    throw new UnauthorizedException('Invalid webhook authentication');
  return { raw, requestId };
}

const sourceSchema = z.object({
  sourceHost: z.string().max(253).transform(normalizeHost),
  siteId: z.string().max(80).optional(),
});

function configuredSource(input: z.infer<typeof sourceSchema>) {
  return (
    input.sourceHost === normalizeHost(required('SOURCE_HOST')) &&
    (!process.env.SOURCE_SITE_ID || input.siteId === process.env.SOURCE_SITE_ID)
  );
}

@Controller()
class PlatformController {
  @Get(['health', 'liveness'])
  live() {
    return { status: 'up' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const [mysql, redisResult] = await Promise.allSettled([rows('SELECT 1'), rate.ping()]);
    const status = mysql.status === 'fulfilled' && redisResult.status === 'fulfilled';
    if (!status) response.status(503);
    return { status: status ? 'ready' : 'unavailable' };
  }

  @Post('api/v1/auth/login')
  @HttpCode(200)
  async login(@Req() request: Request, @Body() body: unknown) {
    await throttle(request, 'login', 12);
    const data = loginSchema.safeParse(body);
    if (!data.success) throw new BadRequestException('Provide an email and password');
    const [user] = await users('email', data.data.email.toLowerCase());
    if (!validPassword(data.data.password, user?.password_hash ?? dummyHash) || !user?.enabled) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return {
      token: jwt.sign({ sub: String(user.id) }, secret('JWT_SECRET'), {
        algorithm: 'HS256',
        expiresIn: '4h',
        issuer: 'ttw-admin',
        audience: 'ttw-platform',
      }),
      email: user.email,
      role: user.role,
    };
  }

  @Post('api/v1/webhooks/wordpress/test')
  @HttpCode(200)
  async testWebhook(@Req() request: ApiRequest, @Body() body: unknown) {
    await authenticateWebhook(request);
    const source = sourceSchema.safeParse(body);
    if (!source.success || !configuredSource(source.data))
      throw new BadRequestException('WordPress source or site ID does not match configuration');
    return { status: 'connected' };
  }

  @Post('api/v1/webhooks/wordpress/categories')
  @HttpCode(200)
  async categorySync(@Req() request: ApiRequest, @Body() body: unknown) {
    await authenticateWebhook(request);
    const input = sourceSchema
      .extend({
        categories: z
          .array(
            z.object({
              id: z.number().int().positive(),
              parent: z.number().int().nonnegative(),
              name: z.string().trim().min(1).max(200),
            }),
          )
          .max(5000),
      })
      .safeParse(body);
    if (!input.success || !configuredSource(input.data))
      throw new BadRequestException('Invalid source or categories');
    const { sourceHost, categories } = input.data;
    await transaction(async (conn) => {
      await execute('DELETE FROM wordpress_categories WHERE source_host=?', [sourceHost], conn);
      if (categories.length)
        await execute(
          `INSERT INTO wordpress_categories (source_host,source_term_id,parent_term_id,name)
         SELECT ?,c.term_id,c.parent_id,c.name FROM JSON_TABLE(?, '$[*]' COLUMNS(
          term_id BIGINT PATH '$.id',parent_id BIGINT PATH '$.parent',name VARCHAR(200) PATH '$.name'
         )) c`,
          [sourceHost, JSON.stringify(categories)],
          conn,
        );
    });
    return { synced: categories.length };
  }

  @Post(['api/v1/webhooks/wordpress/article', 'api/v1/webhooks/wordpress/article/update'])
  @HttpCode(202)
  async webhook(@Req() request: ApiRequest, @Body() body: unknown) {
    const { raw, requestId } = await authenticateWebhook(request);
    const article = articleSchema.safeParse(body);
    if (!article.success) {
      const fields = [...new Set(article.error.issues.map((issue) => issue.path.join('.') || 'body'))];
      console.warn(
        JSON.stringify({ event: 'wordpress_rejected', requestId, reason: 'invalid_payload', fields }),
      );
      throw new BadRequestException(fields);
    }
    const host = normalizeHost(required('SOURCE_HOST'));
    const fields = [];
    if (!configuredSource(article.data))
      fields.push(article.data.sourceHost !== host ? 'sourceHost' : 'siteId');
    if (normalizeHost(new URL(article.data.canonical).hostname) !== host) fields.push('canonical');
    if (fields.length) {
      console.warn(
        JSON.stringify({
          event: 'wordpress_rejected',
          requestId,
          postId: article.data.postId,
          reason: 'source_host_mismatch',
          fields,
        }),
      );
      throw new BadRequestException('Source host does not match configuration');
    }
    const result = await ingest(article.data, requestId, sha256(raw));
    if ('conflict' in result)
      throw new ConflictException('Request ID already belongs to a different payload');
    console.log(JSON.stringify({ event: 'wordpress_received', requestId, ...result }));
    return result;
  }

  @Post('api/v1/webhooks/wordpress/articles/bulk')
  @HttpCode(202)
  async bulk(@Req() request: ApiRequest, @Body() body: unknown) {
    const { raw, requestId } = await authenticateWebhook(request);
    const articles = z.array(articleSchema).min(1).max(20).safeParse(body);
    const host = normalizeHost(required('SOURCE_HOST'));
    if (
      !articles.success ||
      articles.data.some(
        (article) =>
          !configuredSource(article) || normalizeHost(new URL(article.canonical).hostname) !== host,
      )
    )
      throw new BadRequestException('Invalid article payload or source');
    return transaction(async (conn) => {
      const bodyHash = sha256(raw);
      await execute(
        'INSERT IGNORE INTO webhook_logs (request_id,body_hash) VALUES (?,?)',
        [requestId, bodyHash],
        conn,
      );
      const [receipt] = await rows<{ body_hash: string }>(
        'SELECT body_hash FROM webhook_logs WHERE request_id=? FOR UPDATE',
        [requestId],
        conn,
      );
      if (receipt.body_hash !== bodyHash)
        throw new ConflictException('Request ID already belongs to a different payload');
      const results = [];
      for (const [index, article] of articles.data.entries()) {
        const result = await storeArticle(
          conn,
          article,
          sha256(requestId + ':' + index),
          sha256(JSON.stringify(article)),
        );
        if ('conflict' in result)
          throw new ConflictException('Request ID already belongs to a different payload');
        results.push(result);
      }
      return { results };
    });
  }
}

@Module({ controllers: [PlatformController, AdminController] })
class PlatformModule {}

async function start() {
  database();
  required('SOURCE_HOST');
  for (const name of ['JWT_SECRET', 'WEBHOOK_SECRET', 'WEBHOOK_API_KEY']) secret(name);
  const app = await NestFactory.create(PlatformModule, {
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });
  app.use(helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'https:'] } } }));
  app.use((_request: Request, response: Response, next: express.NextFunction) => {
    response.setHeader('X-Robots-Tag', 'noindex');
    next();
  });
  app.use((request: ApiRequest, response: Response, next: express.NextFunction) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) {
      response.on('finish', () => {
        if (!request.adminId) return;
        // Use registered route patterns so arbitrary input and secrets are kept out of the audit trail.
        const path = String(request.route?.path ?? '').slice(0, 255);
        void execute('INSERT INTO admin_activity (user_id,method,path,status) VALUES (?,?,?,?)', [
          request.adminId,
          request.method,
          path,
          response.statusCode,
        ]).catch(() =>
          console.error(JSON.stringify({ event: 'admin_activity_write_failed', userId: request.adminId })),
        );
      });
    }
    next();
  });
  app.use(
    json({
      limit: '1mb',
      verify: (req, _response, buffer) => {
        (req as ApiRequest).rawBody = buffer;
      },
    }),
  );
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  app.use('/assets/ttw', express.static(resolve('apps/web/public/ttw'), { index: false, maxAge: '1h' }));
  const admin = resolve('admin/dist');
  if (existsSync(resolve(admin, 'index.html'))) {
    app.use(express.static(admin, { index: false }));
    app.use((req: Request, res: Response, next: express.NextFunction) => {
      if (req.method === 'GET' && req.path === '/') res.sendFile(resolve(admin, 'index.html'));
      else next();
    });
  }
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? 3000), process.env.BIND_HOST ?? '127.0.0.1');
}
void start().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
