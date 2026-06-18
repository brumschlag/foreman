#!/usr/bin/env node
/**
 * poll-run.mjs — Query PostgreSQL for the most recent run status for a task.
 *
 * Usage:
 *   node poll-run.mjs <project-path> <task-id>
 *
 * Stdout: status string (running, completed, failed, etc.) or "unknown"
 * Exit 0 always (caller handles the status string).
 */

import pg from 'pg';

const [,, projectPath, taskId] = process.argv;

if (!taskId) {
  process.stdout.write('unknown\n');
  process.exit(0);
}

const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/foreman';

const client = new pg.Client({ connectionString: dbUrl });

try {
  await client.connect();
  const result = await client.query(
    `SELECT status FROM runs WHERE bead_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [taskId]
  );
  if (result.rows.length > 0) {
    process.stdout.write(result.rows[0].status + '\n');
  } else {
    process.stdout.write('unknown\n');
  }
  await client.end();
} catch (err) {
  process.stderr.write(`[poll-run] Error: ${err.message}\n`);
  process.stdout.write('unknown\n');
  try { await client.end(); } catch {}
}
