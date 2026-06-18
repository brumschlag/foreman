#!/usr/bin/env node
/**
 * find-patch.mjs — Locate the CHANGES.patch file for the most recent run
 * of a given task, using the Foreman report path conventions.
 *
 * Usage:
 *   node find-patch.mjs <project-path> <task-id>
 *
 * Stdout: absolute path to CHANGES.patch, or empty string if not found.
 * Exit 0 always.
 */

import { ForemanStore } from '/app/dist/lib/store.js';
import { getRunReportsDir } from '/app/dist/lib/report-paths.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [,, projectPath, taskId] = process.argv;

if (!projectPath || !taskId) {
  process.stdout.write('\n');
  process.exit(0);
}

try {
  const store = ForemanStore.forProject(projectPath);
  const project = store.getProjectByPath(projectPath);

  if (!project) {
    process.stdout.write('\n');
    store.close();
    process.exit(0);
  }

  const runs = store.getRunsForSeed(taskId, project.id);
  store.close();

  if (!runs || runs.length === 0) {
    process.stdout.write('\n');
    process.exit(0);
  }

  // Sort by start time descending — most recent run first.
  const sorted = [...runs].sort((a, b) => {
    const ta = new Date(a.started_at ?? a.created_at ?? 0).getTime();
    const tb = new Date(b.started_at ?? b.created_at ?? 0).getTime();
    return tb - ta;
  });

  for (const run of sorted) {
    const reportsDir = getRunReportsDir(project.id, taskId, run.id);
    const patchPath = join(reportsDir, 'CHANGES.patch');
    if (existsSync(patchPath)) {
      process.stdout.write(patchPath + '\n');
      process.exit(0);
    }
  }

  // Not found in any run directory
  process.stdout.write('\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`[find-patch] Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.stdout.write('\n');
  process.exit(0);
}
