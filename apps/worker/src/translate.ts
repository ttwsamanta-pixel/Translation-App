import { Job, UnrecoverableError } from 'bullmq';
import { execute, rows, transaction } from '../../../packages/database/src/db';
import { Article, localizedSlug, sha256 } from '../../../packages/shared/src/article';
import { htmlSegments } from '../../../packages/shared/src/html';
import {
  decryptProviderCredential,
  providerCredentialEncryptionKey,
} from '../../../packages/shared/src/provider-credentials';
import { providers, ProviderError } from '../../../packages/providers/src';
import { Work } from '../../../packages/shared/src/queue';

type Provider = { id: number; adapter: string; cost_inr_per_million: string; encrypted_key: string | null };
type Task = {
  id: number;
  article_id: number;
  domain_id: number;
  provider_id: number;
  fallback_provider_id: number | null;
  source_hash: string;
  code: string;
  payload: Article;
  manual_approval: number;
  eligible: number;
  state: string;
};

async function translate(provider: Provider, task: Task, input: string[], fallback: boolean) {
  const adapter = providers[provider.adapter];
  let credential: string | undefined;
  if (provider.encrypted_key) {
    const encryptionKey = providerCredentialEncryptionKey();
    if (!encryptionKey) throw new ProviderError('provider_credential_key_missing');
    try {
      credential = decryptProviderCredential(provider.encrypted_key, encryptionKey, provider.id);
    } catch {
      throw new ProviderError('provider_credential_unreadable');
    }
  }
  const output = new Map<string, string>();
  const missing: string[] = [];
  for (const text of new Set(input.filter(Boolean))) {
    const [memory] = await rows<{ translated_text: string }>(
      `SELECT translated_text FROM translation_memory
      WHERE source_hash=? AND source_language=? AND target_language=? AND provider_id=?`,
      [sha256(text), task.payload.language, task.code, provider.id],
    );
    if (memory) output.set(text, memory.translated_text);
    else missing.push(text);
  }
  for (let index = 0; index < missing.length;) {
    const batch: string[] = [];
    let bytes = 0;
    while (index < missing.length && batch.length < 50) {
      const text = missing[index];
      const size = Buffer.byteLength(JSON.stringify(text)) + 1;
      if (batch.length && bytes + size > 110_000) break;
      if (size > 110_000) throw new ProviderError('segment_too_large', false);
      bytes += size;
      batch.push(text);
      index++;
    }
    const started = Date.now();
    const characters = batch.reduce((sum, text) => sum + Array.from(text).length, 0);
    let translated: string[] | undefined;
    try {
      if (!adapter?.validateConfiguration(credential)) throw new ProviderError('provider_unconfigured');
      translated = await adapter.translate(
        { text: batch, source: task.payload.language, target: task.code },
        credential,
      );
    } finally {
      await execute(
        `INSERT INTO provider_usage (job_id,provider_id,characters,cost_inr,success,is_fallback,duration_ms)
        VALUES (?,?,?,?,?,?,?)`,
        [
          task.id,
          provider.id,
          characters,
          translated ? (characters * Number(provider.cost_inr_per_million)) / 1_000_000 : 0,
          Boolean(translated),
          fallback,
          Date.now() - started,
        ],
      );
    }
    const segments = translated;
    await transaction(async (conn) => {
      for (const [i, text] of batch.entries()) {
        output.set(text, segments[i]);
        await execute(
          `INSERT IGNORE INTO translation_memory
          (source_hash,source_language,target_language,provider_id,translated_text) VALUES (?,?,?,?,?)`,
          [sha256(text), task.payload.language, task.code, provider.id, segments[i]],
          conn,
        );
      }
    });
  }
  return input.map((text) => output.get(text) ?? '');
}

export async function runJob(job: Job<Work>) {
  const { id, generation } = job.data;
  const [task] = await rows<Task>(
    `SELECT j.*, l.code, v.payload, d.manual_approval,
    (d.enabled AND g.enabled AND a.status='publish' AND a.current_hash=j.source_hash) eligible
    FROM translation_jobs j JOIN domains d ON d.id=j.domain_id JOIN languages l ON l.id=d.language_id
    JOIN translation_groups g ON g.id=d.group_id JOIN articles a ON a.id=j.article_id
    JOIN article_versions v ON v.article_id=j.article_id AND v.source_hash=j.source_hash
    WHERE j.id=? AND j.generation=?`,
    [id, generation],
  );
  if (!task || !['pending', 'retrying', 'processing'].includes(task.state)) return;
  if (!task.eligible) {
    await execute(
      "UPDATE translation_jobs SET state='skipped' WHERE id=? AND generation=? AND state IN ('pending','retrying','processing')",
      [id, generation],
    );
    return;
  }
  const claim = await execute(
    "UPDATE translation_jobs SET state='processing',error_code=NULL WHERE id=? AND generation=? AND state IN ('pending','retrying','processing')",
    [id, generation],
  );
  if (!claim.affectedRows && task.state !== 'processing') return;

  try {
    const parts = htmlSegments(task.payload.content);
    if (!parts.segments.length) throw new ProviderError('empty_article', false);
    const values = [
      task.payload.title,
      task.payload.excerpt,
      task.payload.seoTitle,
      task.payload.seoDescription,
      ...parts.segments,
    ];
    const available = await rows<Provider>(
      `SELECT p.id,p.adapter,p.cost_inr_per_million,c.encrypted_key FROM translation_providers p
       LEFT JOIN provider_credentials c ON c.provider_id=p.id WHERE p.enabled=1 AND p.id IN (?,?)`,
      [task.provider_id, task.fallback_provider_id],
    );
    let selected = available.find((provider) => provider.id === task.provider_id);
    let translated: string[];
    try {
      if (!selected) throw new ProviderError('provider_disabled');
      translated = await translate(selected, task, values, false);
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.transient) throw error;
      const fallback = available.find(
        (provider) => provider.id === task.fallback_provider_id && provider.id !== task.provider_id,
      );
      if (!fallback) throw error;
      console.log(JSON.stringify({ event: 'provider_fallback', jobId: id, reason: error.code }));
      selected = fallback;
      translated = await translate(fallback, task, values, true);
    }
    const [title, excerpt, seoTitle, description, ...content] = translated;
    if (!title.trim() || !content.join('').trim()) throw new ProviderError('empty_translation', false);

    await transaction(async (conn) => {
      await rows('SELECT id FROM articles WHERE id=? FOR UPDATE', [task.article_id], conn);
      const [latest] = await rows<{ state: string; eligible: number; manual_approval: number }>(
        `SELECT j.state,d.manual_approval,
        (d.enabled AND g.enabled AND a.status='publish' AND a.current_hash=j.source_hash) eligible
        FROM translation_jobs j JOIN articles a ON a.id=j.article_id JOIN domains d ON d.id=j.domain_id
        JOIN translation_groups g ON g.id=d.group_id WHERE j.id=? AND j.generation=? FOR UPDATE`,
        [id, generation],
        conn,
      );
      if (latest?.state !== 'processing') return;
      if (!latest.eligible) {
        await execute("UPDATE translation_jobs SET state='skipped' WHERE id=?", [id], conn);
        return;
      }
      const state = latest.manual_approval ? 'review' : 'published';
      const mock = selected.adapter === 'mock';
      const [previous] = await rows<{ slug: string }>(
        'SELECT slug FROM article_translations WHERE article_id=? AND domain_id=? ORDER BY id LIMIT 1',
        [task.article_id, task.domain_id],
        conn,
      );
      const slug = previous?.slug ?? localizedSlug(title, task.article_id);
      if (state === 'published') {
        await execute(
          "UPDATE article_translations SET state='archived' WHERE article_id=? AND domain_id=? AND state='published'",
          [task.article_id, task.domain_id],
          conn,
        );
      }
      await execute(
        `INSERT INTO article_translations
        (article_id,domain_id,job_id,slug,title,excerpt,content,seo_title,seo_description,state,mock)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) AS new
        ON DUPLICATE KEY UPDATE slug=new.slug,title=new.title,excerpt=new.excerpt,content=new.content,
          seo_title=new.seo_title,seo_description=new.seo_description,state=new.state,mock=new.mock`,
        [
          task.article_id,
          task.domain_id,
          id,
          slug,
          title.slice(0, 500),
          excerpt,
          parts.render(content),
          (seoTitle || title).slice(0, 500),
          description || excerpt,
          state,
          mock,
        ],
        conn,
      );
      await execute('UPDATE translation_jobs SET state=? WHERE id=?', [state, id], conn);
    });
  } catch (error) {
    const permanent = error instanceof ProviderError && !error.transient;
    const state = permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1) ? 'failed' : 'retrying';
    const code = error instanceof ProviderError ? error.code : 'translation_processing_error';
    await execute(
      "UPDATE translation_jobs SET state=?,error_code=? WHERE id=? AND generation=? AND state='processing'",
      [state, code, id, generation],
    );
    if (permanent) throw new UnrecoverableError(code);
    throw new Error(code);
  }
}
