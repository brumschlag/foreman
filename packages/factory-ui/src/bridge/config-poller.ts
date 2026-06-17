/**
 * ConfigPoller
 *
 * Watches ~/.foreman/config.yaml and emits config snapshots to registered callbacks.
 * Uses fs.watch for live updates + 10s polling as fallback.
 * On missing file: emits defaults with null fields.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { parse } from "yaml";
import type { ForemanConfig } from "./types.js";

// Default config path - can be overridden for testing
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".foreman", "config.yaml");
const POLL_INTERVAL_MS = 10_000;

// Default config with null fields
const DEFAULT_CONFIG: ForemanConfig = {
  defaultBranch: null,
  models: { default: null },
  pr: { baseBranch: null },
  vcs: { backend: null },
  raw: "",
};

export interface ConfigPollerOptions {
  onConfig: (config: ForemanConfig) => void;
}

export class ConfigPoller {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastContent: string | null = null;
  private readonly configPath: string;

  constructor(private readonly opts: ConfigPollerOptions, configPath?: string) {
    this.configPath = configPath ?? DEFAULT_CONFIG_PATH;
  }

  start(): void {
    console.log(`[config-poller] watching ${this.configPath}`);
    this.readConfig();
    this.startWatch();
    this.startPoll();
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startWatch(): void {
    try {
      this.watcher = fs.watch(path.dirname(this.configPath), (event) => {
        if (event === "rename" || event === "change") {
          this.readConfig();
        }
      });
    } catch (err) {
      console.warn(`[config-poller] fs.watch failed: ${(err as Error).message}`);
    }
  }

  private startPoll(): void {
    const poll = (): void => {
      this.readConfig();
      this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  }

  private readConfig(): void {
    try {
      const content = fs.readFileSync(this.configPath, "utf-8");
      if (content === this.lastContent) return;

      this.lastContent = content;
      const parsed = parse(content) as Record<string, unknown>;

      const config: ForemanConfig = {
        defaultBranch: this.getString(parsed, "defaultBranch"),
        models: {
          default: this.getString(parsed, ["models", "default"]),
        },
        pr: {
          baseBranch: this.getString(parsed, ["pr", "baseBranch"]),
        },
        vcs: {
          backend: this.getString(parsed, ["vcs", "backend"]),
        },
        raw: content,
      };

      this.opts.onConfig(config);
    } catch (err) {
      // File missing or parse error → emit defaults
      if (this.lastContent !== null) {
        console.log(`[config-poller] config missing or invalid, using defaults`);
        this.lastContent = null;
      }
      this.opts.onConfig(DEFAULT_CONFIG);
    }
  }

  private getString(obj: Record<string, unknown>, path: string | string[]): string | null {
    const parts = Array.isArray(path) ? path : [path];
    let current: unknown = obj;

    for (const part of parts) {
      if (!current || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[part];
    }

    return typeof current === "string" ? current : null;
  }
}
