import 'dotenv/config';

export const production = process.env.NODE_ENV === 'production';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function secret(name: string): string {
  const value = required(name);
  if (value.length < 32 || (production && value.startsWith('replace-'))) {
    throw new Error(`${name} requires a random secret of at least 32 characters`);
  }
  return value;
}
