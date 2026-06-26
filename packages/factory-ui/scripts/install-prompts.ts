/**
 * Installs bundled prompts and workflows into the foreman-sample project.
 * Equivalent to what `foreman init` does, minus the br/beads init step.
 */
import { installBundledPrompts, installBundledWorkflows } from "../../src/lib/prompt-loader.js";
import { resolve } from "node:path";

const projectDir = resolve("/home/brian/source/foreman-sample");

console.log("Installing bundled prompts...");
const promptResult = installBundledPrompts(projectDir, true);
console.log(`  installed: ${promptResult.installed.length}`);
console.log(`  skipped:   ${promptResult.skipped.length}`);

console.log("Installing bundled workflows...");
const wfResult = installBundledWorkflows(projectDir, true);
console.log(`  installed: ${wfResult.installed.length}`);
console.log(`  skipped:   ${wfResult.skipped.length}`);

console.log("Done.");
