import { openDatabase } from './executor';
import { migrate } from './migrate';

const url = process.env.DATABASE_URL ?? 'pglite://./.data/pglite';
const db = await openDatabase(url);
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema is up to date.');
await db.close();
