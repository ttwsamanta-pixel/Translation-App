import { Queue, Worker } from 'bullmq';
import { database, rows } from '../../../packages/database/src/db';
import { redis, translationQueue, Work } from '../../../packages/shared/src/queue';
import { runJob } from './translate';

const connection = redis(true);
connection.on('error', (error) => console.error(JSON.stringify({ event: 'redis_error', type: error.name })));
const queue = new Queue<Work>(translationQueue, { connection });
const worker = new Worker<Work>(translationQueue, (job) => runJob(job, connection), {
  connection,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
});
worker.on('error', (error) => console.error(JSON.stringify({ event: 'worker_error', type: error.name })));
worker.on('failed', (job, error) =>
  console.error(JSON.stringify({ event: 'job_failed', jobId: job?.data.id, code: error.message })),
);

let dispatching = false;
async function dispatch() {
  if (dispatching || connection.status !== 'ready') return;
  dispatching = true;
  try {
    const pending = await rows<
      Work & { priority: number }
    >(`SELECT id,generation,priority FROM translation_jobs
      WHERE state='pending' OR (state IN ('processing','retrying') AND updated_at < UTC_TIMESTAMP() - INTERVAL 10 MINUTE)
      ORDER BY priority,id LIMIT 250`);
    await queue.addBulk(
      pending.map(({ id, generation, priority }) => ({
        name: 'translate',
        data: { id, generation },
        opts: {
          jobId: `job-${id}-${generation}`,
          priority,
          attempts: 4,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 3600 },
        },
      })),
    );
    await connection.set('ttw:worker:heartbeat', new Date().toISOString(), 'EX', 20);
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'dispatch_error', type: error instanceof Error ? error.name : 'unknown' }),
    );
  } finally {
    dispatching = false;
  }
}

const timer = setInterval(() => void dispatch(), 2000);
void dispatch();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(timer);
    void worker
      .close()
      .then(() => queue.close())
      .then(() => connection.quit())
      .then(() => database().end());
  });
}
