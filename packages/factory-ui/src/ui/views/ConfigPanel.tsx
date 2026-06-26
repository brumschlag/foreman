import type { ReactNode } from "react";
import { useFactoryStore } from "../store/factoryStore";

function ConfigLabel({ children }: { children: ReactNode }) {
  return <span className="text-[#f59e0b] font-medium">{children}</span>;
}

function ConfigValue({ children, empty = false }: { children?: ReactNode; empty?: boolean }) {
  if (empty) {
    return <span className="text-[#6b7280] italic">not set</span>;
  }
  return <span className="text-white">{children}</span>;
}

function ConfigRow({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-[#2a2f38]">
      <div className="w-32 flex-shrink-0 text-xs uppercase tracking-wider text-[#6b7280]">
        <ConfigLabel>{label}</ConfigLabel>
      </div>
      <div className="flex-1">
        <ConfigValue>{children}</ConfigValue>
      </div>
    </div>
  );
}

function ConfigSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-[#161a1f] rounded-lg p-4 mb-4">
      <div className="text-xs uppercase tracking-wider text-[#f59e0b] font-semibold mb-3">
        {title}
      </div>
      {children}
    </div>
  );
}

export function ConfigPanel() {
  const config = useFactoryStore((s) => s.config);

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#6b7280] text-lg">
        ⬡ No config available
      </div>
    );
  }

  const { defaultBranch, models, pr, vcs, raw } = config;
  const hasConfig = defaultBranch || models.default || pr.baseBranch || vcs.backend;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Config file path */}
      <div className="text-xs text-[#6b7280] font-mono mb-6">
        Config file: ~/.foreman/config.yaml
      </div>

      {/* Parsed key settings */}
      <ConfigSection title="Settings">
        {!hasConfig ? (
          <div className="text-[#6b7280] text-sm italic">
            No configuration found in config file
          </div>
        ) : (
          <>
            <ConfigRow label="Default Branch">
              {defaultBranch ? (
                <span className="text-white font-mono">{defaultBranch}</span>
              ) : (
                <ConfigValue empty />
              )}
            </ConfigRow>
            <ConfigRow label="PR Base">
              {pr.baseBranch ? (
                <span className="text-white font-mono">{pr.baseBranch}</span>
              ) : (
                <ConfigValue empty />
              )}
            </ConfigRow>
            <ConfigRow label="Model">
              {models.default ? (
                <span className="text-white font-mono">{models.default}</span>
              ) : (
                <ConfigValue empty />
              )}
            </ConfigRow>
            <ConfigRow label="VCS Backend">
              {vcs.backend ? (
                <span className="text-white font-mono">{vcs.backend}</span>
              ) : (
                <ConfigValue empty />
              )}
            </ConfigRow>
          </>
        )}
      </ConfigSection>

      {/* Raw YAML */}
      <ConfigSection title="Raw YAML">
        <div className="bg-[#0d0f12] border border-[#2a2f38] rounded-lg overflow-hidden">
          <div className="px-4 py-2 text-xs text-[#6b7280] bg-[#161a1f] border-b border-[#2a2f38]">
            Read-only
          </div>
          <pre className="p-4 text-xs font-mono text-[#e5e7eb] overflow-auto max-h-[500px] whitespace-pre-wrap break-words">
            {raw || "# Config file is empty"}
          </pre>
        </div>
      </ConfigSection>
    </div>
  );
}
