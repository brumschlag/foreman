#!/usr/bin/env node
/**
 * install-workflows.mjs — Install bundled Foreman workflow configs and
 * prompt templates to the user's ~/.foreman/ directory.
 *
 * This is the headless equivalent of `foreman init` for the docker container:
 * it skips the Postgres registration step and only installs the local files
 * that the pipeline worker needs to resolve prompts and workflows.
 *
 * Safe to run multiple times (skips files that already exist).
 */

import { installBundledWorkflows } from '/app/dist/lib/workflow-loader.js';
import { installBundledPrompts } from '/app/dist/lib/prompt-loader.js';

const PROJECT_PATH = '/repo';

try {
  const { installed: wInstalled, skipped: wSkipped } = installBundledWorkflows(PROJECT_PATH, false);
  if (wInstalled.length > 0) {
    process.stderr.write(`[install-workflows] Installed workflows: ${wInstalled.join(', ')}\n`);
  } else {
    process.stderr.write(`[install-workflows] Workflows already installed (${wSkipped.length} skipped)\n`);
  }
} catch (err) {
  process.stderr.write(`[install-workflows] Warning: failed to install workflows: ${err instanceof Error ? err.message : String(err)}\n`);
}

try {
  const { installed: pInstalled, skipped: pSkipped } = installBundledPrompts(PROJECT_PATH, false);
  if (pInstalled.length > 0) {
    process.stderr.write(`[install-workflows] Installed prompts: ${pInstalled.join(', ')}\n`);
  } else {
    process.stderr.write(`[install-workflows] Prompts already installed (${pSkipped.length} skipped)\n`);
  }
} catch (err) {
  process.stderr.write(`[install-workflows] Warning: failed to install prompts: ${err instanceof Error ? err.message : String(err)}\n`);
}
