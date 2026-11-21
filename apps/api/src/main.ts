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
import { database, rows } from '../../../packages/database/src/db';
import { articleSchema, normalizeHost, sha256 } from '../../../packages/shared/src/article';
import { passwordHash, safeEqual, validPassword, verifyWebhook } from '../../../packages/shared/src/auth';
import { required, secret } from '../../../packages/shared/src/config';
import { redis } from '../../../packages/shared/src/queue';
import { ingest } from './ingest';
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

  @Post(['api/v1/webhooks/wordpress/article', 'api/v1/webhooks/wordpress/article/update'])
  @HttpCode(202)
  async webhook(@Req() request: ApiRequest, @Body() body: unknown) {
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
    ) {
      throw new UnauthorizedException('Invalid webhook authentication');
    }
    const article = articleSchema.safeParse(body);
    if (!article.success)
      throw new BadRequestException(article.error.issues.map((issue) => issue.path.join('.')));
    const host = normalizeHost(required('SOURCE_HOST'));
    if (
      article.data.sourceHost !== host ||
      normalizeHost(new URL(article.data.canonical).hostname) !== host
    ) {
      throw new BadRequestException('Source host does not match configuration');
    }
    const result = await ingest(article.data, requestId, sha256(raw));
    if ('conflict' in result)
      throw new ConflictException('Request ID already belongs to a different payload');
    console.log(JSON.stringify({ event: 'wordpress_received', requestId, ...result }));
    return result;
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
  app.use(helmet());
  app.use((_request: Request, response: Response, next: express.NextFunction) => {
    response.setHeader('X-Robots-Tag', 'noindex');
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
