import { PoolConnection } from 'mysql2/promise';
import { execute, rows, transaction } from '../../../packages/database/src/db';
import { refreshWebsiteCache } from '../../../packages/database/src/website';
import { Article, contentHash, localDay } from '../../../packages/shared/src/article';

export async function distribute(
  conn: PoolConnection,
  id: number,
  hash: string,
  article: Pick<Article, 'language' | 'categories' | 'articleType'>,
  target?: number,
) {
  const domains = await rows<{
    id: number;
    group_id: number;
    timezone: string;
    daily_limit: number;
    priority: number;
    code: string;
    provider_id: number;
    fallback_provider_id: number | null;
  }>(
    `SELECT d.id,d.group_id,d.timezone,COALESCE(d.daily_limit,g.daily_limit) daily_limit,COALESCE(r.priority,g.priority) priority,l.code,
          COALESCE(r.provider_id,g.provider_id) provider_id,COALESCE(r.fallback_provider_id,g.fallback_provider_id) fallback_provider_id
       FROM domains d JOIN languages l ON l.id=d.language_id
       JOIN translation_groups g ON g.id=d.group_id LEFT JOIN domain_routing r ON r.domain_id=d.id
       WHERE d.enabled=1 AND g.enabled=1 AND (? IS NULL OR d.id=?)
       ORDER BY d.id FOR UPDATE`,
    [target ?? null, target ?? null],
    conn,
  );
  const staticPage = article.articleType === 'page';
  const [configuration] = staticPage
    ? [{ configured: 0 }]
    : await rows<{ configured: number }>(
        'SELECT EXISTS(SELECT 1 FROM distribution_rules) configured',
        [],
        conn,
      );
  const rules = configuration.configured
    ? await rows<{
        id: number;
        domain_id: number | null;
        group_id: number | null;
        priority: number;
        daily_limit: number;
        provider_id: number | null;
        fallback_provider_id: number | null;
      }>(
        `SELECT id,domain_id,group_id,priority,daily_limit,provider_id,fallback_provider_id
      FROM distribution_rules WHERE enabled=1 AND CONVERT(category USING utf8mb4) COLLATE utf8mb4_0900_ai_ci IN (
        SELECT CONVERT(name USING utf8mb4) COLLATE utf8mb4_0900_ai_ci
        FROM JSON_TABLE(?, '$[*]' COLUMNS(name VARCHAR(200) PATH '$')) categories
      ) ORDER BY priority,(domain_id IS NULL),id`,
        [JSON.stringify(article.categories)],
        conn,
      )
    : [];
  const date = new Date();
  const utcDay = date.toISOString().slice(0, 10);
  let created = 0;
  for (const domain of domains) {
    if (domain.code.split('-')[0] === article.language.split('-')[0]) continue;
    const matching = rules.filter(
      (rule) => rule.domain_id === domain.id || rule.group_id === domain.group_id,
    );
    if (configuration.configured && !matching.length) continue;
    const [prior] = await rows<{ id: number; source_hash: string }>(
      'SELECT id,source_hash FROM translation_jobs WHERE article_id=? AND domain_id=? ORDER BY (source_hash=?) DESC,id DESC LIMIT 1',
      [id, domain.id, hash],
      conn,
    );
    if (prior?.source_hash === hash) {
      await execute(
        `UPDATE translation_jobs SET state='pending',generation=generation+1,error_code=NULL
        WHERE id=? AND state IN ('skipped','published','review') AND NOT EXISTS
        (SELECT 1 FROM article_translations WHERE job_id=? AND state IN ('published','review'))`,
        [prior.id, prior.id],
        conn,
      );
      continue;
    }
    let selected = matching[0];
    if (!prior && !staticPage) {
      const day = localDay(date, domain.timezone);
      await execute(
        'INSERT IGNORE INTO daily_allocations (domain_id,local_day) VALUES (?,?)',
        [domain.id, day],
        conn,
      );
      const [allocation] = await rows<{ used: number }>(
        'SELECT used FROM daily_allocations WHERE domain_id=? AND local_day=? FOR UPDATE',
        [domain.id, day],
        conn,
      );
      if (allocation.used >= domain.daily_limit) continue;
      if (configuration.configured) {
        let reserved = false;
        for (const rule of matching) {
          await execute(
            'INSERT IGNORE INTO distribution_allocations (rule_id,utc_day) VALUES (?,?)',
            [rule.id, utcDay],
            conn,
          );
          const [quota] = await rows<{ used: number }>(
            'SELECT used FROM distribution_allocations WHERE rule_id=? AND utc_day=? FOR UPDATE',
            [rule.id, utcDay],
            conn,
          );
          const [existing] = await rows<{ article_id: number }>(
            'SELECT article_id FROM distributed_articles WHERE rule_id=? AND utc_day=? AND article_id=? FOR UPDATE',
            [rule.id, utcDay, id],
            conn,
          );
          if (!existing) {
            if (quota.used >= rule.daily_limit) continue;
            await execute('INSERT INTO distributed_articles VALUES (?,?,?)', [rule.id, utcDay, id], conn);
            await execute(
              'UPDATE distribution_allocations SET used=used+1 WHERE rule_id=? AND utc_day=?',
              [rule.id, utcDay],
              conn,
            );
          }
          selected = rule;
          reserved = true;
          break;
        }
        if (!reserved) continue;
      }
      await execute(
        'UPDATE daily_allocations SET used=used+1 WHERE domain_id=? AND local_day=?',
        [domain.id, day],
        conn,
      );
    }
    const provider = selected?.provider_id ?? domain.provider_id;
    const fallback = selected?.fallback_provider_id ?? domain.fallback_provider_id;
    await execute(
      `INSERT INTO translation_jobs (article_id,domain_id,source_hash,provider_id,fallback_provider_id,priority)
      VALUES (?,?,?,?,?,?)`,
      [
        id,
        domain.id,
        hash,
        provider,
        fallback === provider ? null : fallback,
        selected?.priority ?? domain.priority,
      ],
      conn,
    );
    created++;
  }
  return created;
}

export async function ingest(article: Article, requestId: string, bodyHash: string) {
  return transaction((conn) => storeArticle(conn, article, requestId, bodyHash));
}

export async function storeArticle(
  conn: PoolConnection,
  article: Article,
  requestId: string,
  bodyHash: string,
) {
  await execute(
    'INSERT IGNORE INTO webhook_logs (request_id,body_hash) VALUES (?,?)',
    [requestId, bodyHash],
    conn,
  );
  const [receipt] = await rows<{ body_hash: string; article_id: number | null }>(
    'SELECT body_hash,article_id FROM webhook_logs WHERE request_id=? FOR UPDATE',
    [requestId],
    conn,
  );
  if (receipt.body_hash !== bodyHash) return { conflict: true };
  if (receipt.article_id) return { articleId: receipt.article_id, created: 0, duplicate: true };

  const hash = contentHash(article);
  const type = article.articleType === 'page' ? 'page' : 'post';
  const published = new Date(article.publishedAt);
  const modified = new Date(article.modifiedAt);
  const insert = await execute(
    `INSERT INTO articles
      (source_host,source_post_id,current_hash,title,canonical,category,status,published_at,modified_at,content_type)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
    [
      article.sourceHost,
      article.postId,
      hash,
      article.title,
      article.canonical,
      article.categories[0] ?? '',
      article.status,
      published,
      modified,
      type,
    ],
    conn,
  );
  const id = insert.insertId;
  const [current] = await rows<{ current_hash: string; modified_at: Date }>(
    'SELECT current_hash,modified_at FROM articles WHERE id=? FOR UPDATE',
    [id],
    conn,
  );
  await execute('UPDATE webhook_logs SET article_id=? WHERE request_id=?', [id, requestId], conn);
  if (modified < current.modified_at) return { articleId: id, created: 0, stale: true };

  const snapshot = await execute(
    'INSERT IGNORE INTO article_versions (article_id,source_hash,payload) VALUES (?,?,?)',
    [id, hash, JSON.stringify(article)],
    conn,
  );
  if (current.current_hash === hash && !snapshot.affectedRows) {
    await execute('UPDATE articles SET modified_at=? WHERE id=?', [modified, id], conn);
    return {
      articleId: id,
      created:
        type === 'page' && article.status === 'publish' ? await distribute(conn, id, hash, article) : 0,
      unchanged: true,
    };
  }
  await execute(
    `UPDATE articles SET current_hash=?,title=?,canonical=?,category=?,status=?,published_at=?,modified_at=?,content_type=? WHERE id=?`,
    [
      hash,
      article.title,
      article.canonical,
      article.categories[0] ?? '',
      article.status,
      published,
      modified,
      type,
      id,
    ],
    conn,
  );
  await execute(
    "UPDATE article_translations SET state='archived' WHERE article_id=? AND state='review'",
    [id],
    conn,
  );
  await execute(
    "UPDATE translation_jobs SET state='skipped' WHERE article_id=? AND source_hash<>? AND state='review'",
    [id, hash],
    conn,
  );
  if (article.status === 'withdrawn') {
    const affected = await rows<{ domain_id: number }>(
      "SELECT DISTINCT domain_id FROM article_translations WHERE article_id=? AND state='published' ORDER BY domain_id",
      [id],
      conn,
    );
    await execute(
      "UPDATE article_translations SET state='archived' WHERE article_id=? AND state='published'",
      [id],
      conn,
    );
    for (const { domain_id } of affected) await refreshWebsiteCache(domain_id, conn);
    return { articleId: id, created: 0 };
  }
  return { articleId: id, created: await distribute(conn, id, hash, article) };
}
