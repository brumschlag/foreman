#!/usr/bin/env node
/**
 * find-patch.mjs — Locate CHANGES.patch for a task via PostgreSQL.
 *
 * Usage:
 *   node find-patch.mjs <project-path> <task-id>
 *
 * Stdout: absolute path to CHANGES.patch, or empty string if not found.
 */

import pg from 'pg';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const [,, projectPath, taskId] = process.argv;

if (!taskId) {
  process.stdout.write('\n');
  process.exit(0);
}

const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/foreman';
const client = new pg.Client({ connectionString: dbUrl });

try {
  await client.connect();

  // Get the project ID and most recent run ID
  const projResult = await client.query(
    `SELECT id FROM projects WHERE path = $1 LIMIT 1`,
    [projectPath]
  );
  const runResult = await client.query(
    `SELECT id, project_id FROM runs WHERE bead_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [taskId]
  );

  await client.end();

  if (runResult.rows.length > 0) {
    const { id: runId, project_id: projectId } = runResult.rows[0];
    const patchPath = join(homedir(), '.foreman', 'reports', projectId, taskId, runId, 'CHANGES.patch');
    if (existsSync(patchPath)) {
      process.stdout.write(patchPath + '\n');
      process.exit(0);
    }
  }

  process.stdout.write('\n');
} catch (err) {
  process.stderr.write(`[find-patch] Error: ${err.message}\n`);
  try { await client.end(); } catch { /* best-effort cleanup */ }
  process.stdout.write('\n');
}
