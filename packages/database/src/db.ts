import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { required } from '../../shared/src/config';

let connectionPool: Pool | undefined;

export function database() {
  connectionPool ??= mysql.createPool({
    uri: required('DATABASE_URL'),
    connectionLimit: 12,
    timezone: 'Z',
    charset: 'utf8mb4',
    supportBigNumbers: true,
  });
  return connectionPool;
}

type Connection = Pool | PoolConnection;

export async function rows<T>(
  sql: string,
  params: (string | number | boolean | Date | null)[] = [],
  conn: Connection = database(),
): Promise<T[]> {
  const [result] = await conn.execute<RowDataPacket[]>(sql, params);
  return result as T[];
}

export async function execute(
  sql: string,
  params: (string | number | boolean | Date | null)[] = [],
  conn: Connection = database(),
) {
  const [result] = await conn.execute<ResultSetHeader>(sql, params);
  return result;
}

export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await database().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
