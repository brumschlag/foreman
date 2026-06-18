#!/usr/bin/env node
/**
 * bootstrap.mjs — Create a Foreman task in the local SQLite store without
 * requiring a Postgres connection or a registered project.
 *
 * Usage:
 *   node bootstrap.mjs <project-path> <title> [description]
 *
 * Stdout: the allocated task ID (e.g. "repo-a1b2c")
 * Stderr: progress / errors
 * Exit 0 on success, 1 on failure.
 *
 * Called by docker-entrypoint.sh before handing off to:
 *   foreman run task <id> no-pr --project-path <path> --no-watch
 */

import { ForemanStore } from '/app/dist/lib/store.js';
import { NativeTaskStore } from '/app/dist/lib/task-store.js';
import { basename } from 'node:path';

const [,, projectPath, title, description] = process.argv;

if (!projectPath || !title) {
  process.stderr.write('Usage: bootstrap.mjs <project-path> <title> [description]\n');
  process.exit(1);
}

try {
  const store = ForemanStore.forProject(projectPath);

  // Register project in local SQLite if not already present.
  let project = store.getProjectByPath(projectPath);
  if (!project) {
    project = store.registerProject(basename(projectPath), projectPath);
    process.stderr.write(`[bootstrap] Registered project: ${project.id}\n`);
  } else {
    process.stderr.write(`[bootstrap] Using existing project: ${project.id}\n`);
  }

  // Create the task via NativeTaskStore (SQLite, no Postgres required).
  // NativeTaskStore.create() auto-generates the task ID from the project name.
  const taskStore = new NativeTaskStore(store.getDb());
  const task = taskStore.create({
    title,
    description: description || null,
    type: 'task',
    priority: 2, // medium
  });

  process.stderr.write(`[bootstrap] Created task: ${task.id} — "${task.title}"\n`);
  store.close();

  // Print just the task ID to stdout for the shell script to capture.
  process.stdout.write(task.id + '\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`[bootstrap] Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
