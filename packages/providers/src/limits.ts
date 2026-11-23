import { randomUUID } from 'node:crypto';
import type IORedis from 'ioredis';

export type ProviderLimits = {
  requests_per_minute: number | null;
  requests_per_day: number | null;
  concurrent_requests: number | null;
};

const acquire = `
  local now = tonumber(ARGV[1])
  local minute = tonumber(ARGV[2])
  local day = tonumber(ARGV[3])
  local concurrency = tonumber(ARGV[4])
  if minute > 0 and tonumber(redis.call('GET', KEYS[1]) or '0') >= minute then return 0 end
  if day > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') >= day then return 0 end
  if concurrency > 0 then
    redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
    if redis.call('ZCARD', KEYS[3]) >= concurrency then return 0 end
    redis.call('ZADD', KEYS[3], now + 120000, ARGV[5])
    redis.call('PEXPIRE', KEYS[3], 120000)
  end
  if minute > 0 and redis.call('INCR', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], 120) end
  if day > 0 and redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], 172800) end
  return 1
`;

export async function reserveProviderRequest(redis: IORedis, providerId: number, limits: ProviderLimits) {
  const { requests_per_minute: minute, requests_per_day: day, concurrent_requests: concurrency } = limits;
  if (!minute && !day && !concurrency) return async () => {};
  const now = Date.now();
  const prefix = `ttw:provider:${providerId}:`;
  const leases = prefix + 'leases';
  const id = randomUUID();
  const allowed = await redis.eval(
    acquire,
    3,
    prefix + 'minute:' + Math.floor(now / 60_000),
    prefix + 'day:' + Math.floor(now / 86_400_000),
    leases,
    now,
    minute ?? 0,
    day ?? 0,
    concurrency ?? 0,
    id,
  );
  if (!allowed) return undefined;
  return async () => {
    if (concurrency) await redis.zrem(leases, id).catch(() => undefined);
  };
}
