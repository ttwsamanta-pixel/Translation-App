import { readFile, readdir } from 'node:fs/promises';
import { database, execute, rows } from '../packages/database/src/db';
import { production, required } from '../packages/shared/src/config';
import { normalizeHost } from '../packages/shared/src/article';
import { passwordHash } from '../packages/shared/src/auth';

async function migrate() {
  const conn = await database().getConnection();
  try {
    const [lock] = await conn.query("SELECT GET_LOCK('ttw_translation_migrations', 30) AS acquired");
    if (!(lock as { acquired: number }[])[0].acquired) throw new Error('Could not acquire migration lock');
    await execute('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(200) PRIMARY KEY)', [], conn);
    const applied = new Set(
      (await rows<{ name: string }>('SELECT name FROM schema_migrations', [], conn)).map((row) => row.name),
    );
    for (const name of (await readdir('database/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      if (applied.has(name)) continue;
      const sql = await readFile(`database/migrations/${name}`, 'utf8');
      for (const statement of sql
        .split(';')
        .map((value) => value.trim())
        .filter(Boolean)) {
        await execute(statement, [], conn);
      }
      await execute('INSERT INTO schema_migrations (name) VALUES (?)', [name], conn);
      console.log(`Applied ${name}`);
    }
  } finally {
    await conn.query("SELECT RELEASE_LOCK('ttw_translation_migrations')");
    conn.release();
  }
}

async function seed() {
  const password = required('ADMIN_PASSWORD');
  if (password.length < 12 || (production && password.startsWith('replace-')))
    throw new Error('Set a strong ADMIN_PASSWORD');
  const hostname = normalizeHost(required('PILOT_HOST'));
  const origin = new URL(required('PILOT_ORIGIN'));
  if (
    normalizeHost(origin.hostname) !== hostname ||
    origin.origin !== required('PILOT_ORIGIN') ||
    (production ? origin.protocol !== 'https:' : !['http:', 'https:'].includes(origin.protocol))
  ) {
    throw new Error('PILOT_ORIGIN must be an origin matching PILOT_HOST');
  }
  const mock = !production && process.env.ALLOW_MOCK_TRANSLATION === 'true' && !process.env.DEEPL_API_KEY;
  if (!mock && !process.env.DEEPL_API_KEY) throw new Error('Set DEEPL_API_KEY or enable the local mock');
  await execute("INSERT IGNORE INTO users (email,password_hash,role) VALUES (?,?,'super_admin')", [
    required('ADMIN_EMAIL').toLowerCase(),
    passwordHash(password),
  ]);
  await execute("INSERT IGNORE INTO languages (code,name) VALUES ('fr-FR','French')");
  await execute(
    'INSERT IGNORE INTO translation_providers (name,adapter,cost_inr_per_million) VALUES (?,?,?)',
    [
      mock ? 'Development Mock' : 'DeepL',
      mock ? 'mock' : 'deepl',
      mock ? 0 : Number(process.env.DEEPL_COST_INR_PER_MILLION ?? 0),
    ],
  );
  await execute(
    "INSERT IGNORE INTO translation_groups (name,description,daily_limit,provider_id) SELECT 'Premium','Pilot French publishing',100,id FROM translation_providers WHERE adapter=?",
    [mock ? 'mock' : 'deepl'],
  );
  await execute(
    "INSERT IGNORE INTO domains (hostname,origin,language_id,group_id) SELECT ?,?,l.id,g.id FROM languages l CROSS JOIN translation_groups g WHERE l.code='fr-FR' AND g.name='Premium'",
    [hostname, origin.origin],
  );
  console.log(`Pilot domain configured for ${hostname}`);
}

(process.argv[2] === 'migrate' ? migrate() : seed())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => database().end());
