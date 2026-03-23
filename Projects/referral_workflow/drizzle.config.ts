import type { Config } from 'drizzle-kit';

const config: Config = {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? './referral.db',
  },
};

export default config;
