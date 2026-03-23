import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config';

const sqlite = new Database(config.database.url);
const db = drizzle(sqlite);

console.log('Running database migrations...');
migrate(db, { migrationsFolder: './src/db/migrations' });
console.log('Migrations complete.');
sqlite.close();
