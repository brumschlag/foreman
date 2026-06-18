#!/usr/bin/env node
/**
 * bootstrap.mjs — Register project + create task so `foreman run task` can find them.
 *
 * Inserts directly into Postgres and writes the project to ProjectRegistry JSON
 * so `foreman run task --project-path` can resolve the project ID.
 *
 * Usage:
 *   node bootstrap.mjs <project-path> <title> [description]
 *
 * Stdout: the task ID
 * Stderr: progress / errors
 */

import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const [,, projectPath, title, description] = process.argv;

if (!projectPath || !title) {
  process.stderr.write('Usage: bootstrap.mjs <project-path> <title> [description]\n');
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:***@localhost:5432/foreman';

// ── Step 1: Insert project into Postgres (if not exists) ───────────────────────
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

let projectId;

try {
  const existingProj = await client.query(
    'SELECT id FROM projects WHERE path = $1', [projectPath]
  );

  if (existingProj.rows.length > 0) {
    projectId = existingProj.rows[0].id;
    process.stderr.write(`[bootstrap] Using existing project: ${projectId}\n`);
  } else {
    projectId = randomUUID();
    const projectName = basename(projectPath);
    await client.query(
      `INSERT INTO projects (id, name, path, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', now(), now())`,
      [projectId, projectName, projectPath]
    );
    process.stderr.write(`[bootstrap] Registered project in Postgres: ${projectId}\n`);
  }
} catch (err) {
  process.stderr.write(`[bootstrap] Postgres project error: ${err.message}\n`);
  await client.end();
  process.exit(1);
}

// ── Step 2: Write project to ProjectRegistry JSON ────────────────────────────
const registryDir = join(homedir(), '.foreman', 'projects');
const registryFile = join(registryDir, 'projects.json');

try {
  await mkdir(registryDir, { recursive: true });

  let records = [];
  if (existsSync(registryFile)) {
    try {
      const raw = await readFile(registryFile, 'utf8');
      records = JSON.parse(raw);
      if (!Array.isArray(records)) records = [];
    } catch { records = []; }
  }

  const alreadyInJson = records.some(r => r.path === projectPath);
  if (!alreadyInJson) {
    records.push({
      id: projectId,
      name: basename(projectPath),
      path: projectPath,
      githubUrl: '',
      repoKey: null,
      defaultBranch: 'main',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await writeFile(registryFile, JSON.stringify(records, null, 2), 'utf8');
    process.stderr.write(`[bootstrap] Wrote project to registry JSON\n`);
  }
} catch (err) {
  process.stderr.write(`[bootstrap] Registry JSON error: ${err.message}\n`);
  // Non-fatal — foreman run task may still find the project via --project-path
}

// ── Step 3: Create task in Postgres ──────────────────────────────────────────
const taskId = `foreman-${randomUUID().replace(/-/g, '').slice(0, 5)}`;
const now = new Date().toISOString();

try {
  await client.query(
    `INSERT INTO tasks (id, project_id, title, description, type, priority, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'feature', 2, 'ready', $5, $5)`,
    [taskId, projectId, title, description || null, now]
  );
  process.stderr.write(`[bootstrap] Created task: ${taskId} — "${title}"\n`);
  await client.end();

  process.stdout.write(taskId + '\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`[bootstrap] Task error: ${err.message}\n`);
  if (err.stack) process.stderr.write(err.stack + '\n');
  await client.end();
  process.exit(1);
}
