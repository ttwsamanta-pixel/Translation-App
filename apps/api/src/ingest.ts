import { PoolConnection } from 'mysql2/promise';
import { execute, rows, transaction } from '../../../packages/database/src/db';
import { Article, contentHash, localDay } from '../../../packages/shared/src/article';

export async function distribute(
  conn: PoolConnection,
  id: number,
  hash: string,
  language: string,
  target?: number,
) {
  const domains = await rows<{
    id: number;
    timezone: string;
    daily_limit: number;
    priority: number;
    code: string;
    provider_id: number;
    fallback_provider_id: number | null;
  }>(
    `SELECT d.id,d.timezone,COALESCE(d.daily_limit,g.daily_limit) daily_limit,g.priority,l.code,
          g.provider_id,g.fallback_provider_id
       FROM domains d JOIN languages l ON l.id=d.language_id
       JOIN translation_groups g ON g.id=d.group_id
       WHERE d.enabled=1 AND g.enabled=1 AND (? IS NULL OR d.id=?)
       ORDER BY d.id FOR UPDATE`,
    [target ?? null, target ?? null],
    conn,
  );
  let created = 0;
  for (const domain of domains) {
    if (domain.code.split('-')[0] === language.split('-')[0]) continue;
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
    if (!prior) {
      const day = localDay(new Date(), domain.timezone);
      await execute(
        'INSERT IGNORE INTO daily_allocations (domain_id,local_day) VALUES (?,?)',
        [domain.id, day],
        conn,
      );
      const reserved = await execute(
        'UPDATE daily_allocations SET used=used+1 WHERE domain_id=? AND local_day=? AND used<?',
        [domain.id, day, domain.daily_limit],
        conn,
      );
      if (!reserved.affectedRows) continue;
    }
    await execute(
      `INSERT INTO translation_jobs (article_id,domain_id,source_hash,provider_id,fallback_provider_id,priority)
      VALUES (?,?,?,?,?,?)`,
      [id, domain.id, hash, domain.provider_id, domain.fallback_provider_id, domain.priority],
      conn,
    );
    created++;
  }
  return created;
}

export async function ingest(article: Article, requestId: string, bodyHash: string) {
  return transaction(async (conn) => {
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
    const published = new Date(article.publishedAt);
    const modified = new Date(article.modifiedAt);
    const insert = await execute(
      `INSERT INTO articles
      (source_host,source_post_id,current_hash,title,canonical,category,status,published_at,modified_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
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
      return { articleId: id, created: 0, unchanged: true };
    }
    await execute(
      `UPDATE articles SET current_hash=?,title=?,canonical=?,category=?,status=?,published_at=?,modified_at=? WHERE id=?`,
      [
        hash,
        article.title,
        article.canonical,
        article.categories[0] ?? '',
        article.status,
        published,
        modified,
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
      await execute(
        "UPDATE article_translations SET state='archived' WHERE article_id=? AND state='published'",
        [id],
        conn,
      );
      return { articleId: id, created: 0 };
    }
    return { articleId: id, created: await distribute(conn, id, hash, article.language) };
  });
}
