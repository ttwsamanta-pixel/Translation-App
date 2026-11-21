import IORedis from 'ioredis';
import { required } from './config';

export const translationQueue = 'translation';
export type Work = { id: number; generation: number };

export function redis(worker = false) {
  return new IORedis(required('REDIS_URL'), {
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
    connectTimeout: 5000,
  });
}
