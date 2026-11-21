import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function passwordHash(password: string, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function validPassword(password: string, stored: string) {
  return safeEqual(passwordHash(password, stored.split(':')[0]), stored);
}

export function signWebhook(body: Buffer, timestamp: string, requestId: string, secret: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${requestId}.`).update(body).digest('hex');
}

export function verifyWebhook(
  body: Buffer,
  timestamp: string,
  requestId: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  return (
    /^\d{10}$/.test(timestamp) &&
    /^[\w-]{16,80}$/.test(requestId) &&
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) <= 300 &&
    safeEqual(signWebhook(body, timestamp, requestId, secret), signature)
  );
}
