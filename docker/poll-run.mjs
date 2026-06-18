#!/usr/bin/env node
/**
 * poll-run.mjs — Query the local SQLite store for the most recent run status
 * for a given task.
 *
 * Usage:
 *   node poll-run.mjs <project-path> <task-id>
 *
 * Stdout: run status string (e.g. "running", "completed", "failed")
 *         or "pending" if no run exists yet.
 * Exit 0 always (errors print "unknown" to stdout).
 */

import { ForemanStore } from '/app/dist/lib/store.js';

const [,, projectPath, taskId] = process.argv;

if (!projectPath || !taskId) {
  process.stdout.write('unknown\n');
  process.exit(0);
}

try {
  const store = ForemanStore.forProject(projectPath);

  // Get the project record
  const project = store.getProjectByPath(projectPath);
  if (!project) {
    process.stdout.write('pending\n');
    store.close();
    process.exit(0);
  }

  // Get all runs for this task and find the most recent one
  const runs = store.getRunsForSeed(taskId, project.id);
  store.close();

  if (!runs || runs.length === 0) {
    process.stdout.write('pending\n');
    process.exit(0);
  }

  // Sort by created_at descending to get the most recent run
  const sorted = [...runs].sort((a, b) => {
    const ta = new Date(a.started_at ?? a.created_at ?? 0).getTime();
    const tb = new Date(b.started_at ?? b.created_at ?? 0).getTime();
    return tb - ta;
  });

  const latest = sorted[0];
  process.stdout.write((latest.status ?? 'unknown') + '\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`[poll-run] Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.stdout.write('unknown\n');
  process.exit(0);
}
