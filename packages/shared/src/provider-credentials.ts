import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function providerCredentialEncryptionKey() {
  const key = process.env.PROVIDER_CREDENTIAL_SECRET ?? '';
  return /^[a-f0-9]{64}$/i.test(key) ? Buffer.from(key, 'hex') : undefined;
}

export function encryptProviderCredential(value: string, key: Buffer, providerId: number) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(String(providerId)));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptProviderCredential(value: string, key: Buffer, providerId: number) {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid provider credential format');
  const [nonce, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(String(providerId)));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
