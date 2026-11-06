/**
 * End-of-day: mark booked/reminded appointments as missed.
 * Usage:
 *   node scripts/eod-mark-missed.js
 *   node scripts/eod-mark-missed.js 2026-11-06
 *
 * Cron example (host timezone):
 *   5 0 * * * cd /path/to/backend && node scripts/eod-mark-missed.js >> /var/log/hms-eod.log 2>&1
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { markMissedEndOfDay } from '../src/services/appointmentService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const asOfDate = process.argv[2] || null;
const result = await markMissedEndOfDay({
  asOfDate,
  actor: { id: null, email: 'eod-cron@local', role: 'Admin' },
});
console.log(JSON.stringify({ ok: true, ...result, ran_at: new Date().toISOString() }, null, 2));
