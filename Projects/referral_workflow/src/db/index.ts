import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { config } from '../config';

const sqlite = new Database(config.database.url);

// Enable WAL mode for better concurrent read performance
sqlite.pragma('journal_mode = WAL');

export const db = drizzle(sqlite, { schema });
export type Db = typeof db;
