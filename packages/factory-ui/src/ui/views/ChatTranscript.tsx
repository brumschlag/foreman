import { useEffect, useState } from "react";
import { useFactoryStore } from "../store/factoryStore";
import type { ChatTurn } from "../../bridge/types";
import { requestTranscript } from "../hooks/useFactorySocket";

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function formatUsage(usage?: { input: number; output: number; cost: { total: number } }): string {
  if (!usage) return "";
  return `input: ${usage.input} | output: ${usage.output} | cost: $${usage.cost.total.toFixed(6)}`;
}

export function ChatTranscript({ runId }: { runId: string }) {
  const transcripts = useFactoryStore((s) => s.transcripts);
  const turns = transcripts[runId] || [];

  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (transcripts[runId]) {
      setIsLoading(false);
    }
  }, [runId, transcripts]);

  function handleLoad() {
    setIsLoading(true);
    requestTranscript(runId);
  }

  return (
    <div className="px-4 py-3 border-b border-[#2a2f38]">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[#6b7280] uppercase tracking-wider font-semibold text-xs">Chat Transcript</span>
          {isLoading && <span className="text-[#f59e0b] text-xs animate-pulse">loading…</span>}
        </div>
        <span className="text-[#6b7280] text-xs font-mono">
          {turns.length} turn{turns.length !== 1 ? "s" : ""}
        </span>
      </div>

      {turns.length === 0 ? (
        <div className="text-xs text-[#4b5563]">
          {isLoading ? (
            <span className="text-[#f59e0b] animate-pulse">Fetching transcript…</span>
          ) : (
            <button
              onClick={handleLoad}
              className="text-[#f59e0b] hover:text-white transition-colors underline"
            >
              Load transcript
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {turns.map((turn, idx) => (
            <div key={idx} className="flex flex-col gap-2 bg-[#0a0a0a] rounded-lg p-3 border border-[#1a1a1a]">
              {/* Turn header */}
              <div className="flex items-center gap-2 text-xs">
                {turn.role === "assistant" ? (
                  <>
                    <span className="inline-flex items-center justify-center w-5 h-5 bg-[#f59e0b]/20 text-[#f59e0b] rounded text-[10px] font-bold">
                      AI
                    </span>
                    <span className="text-[#f59e0b] font-semibold uppercase">Assistant</span>
                  </>
                ) : (
                  <span className="text-[#6b7280] uppercase text-[10px]">Tool Results</span>
                )}
                {turn.usage && (
                  <span className="ml-auto text-[#4b5563] font-mono text-[10px]">{formatUsage(turn.usage)}</span>
                )}
              </div>

              {/* Assistant text */}
              {turn.role === "assistant" && turn.text && (
                <div className="text-[#d4d4d4] text-sm leading-relaxed">
                  <p className="text-[#f59e0b] whitespace-pre-wrap">{turn.text}</p>
                </div>
              )}

              {/* Tool calls */}
              {turn.toolCalls.length > 0 && (
                <div className="flex flex-col gap-1">
                  {turn.toolCalls.map((call, callIdx) => (
                    <details key={callIdx} className="group">
                      <summary className="flex items-center gap-2 cursor-pointer list-none text-xs py-1">
                        <span className="text-[#22c55e] bg-[#22c55e]/10 px-1.5 py-0.5 rounded font-mono">
                          {call.name}
                        </span>
                        <span className="text-[#6b7280]">{call.id.slice(0, 8)}</span>
                        <span className="text-[#6b7280] group-open:rotate-180 transition-transform ml-auto">▼</span>
                      </summary>
                      <div className="mt-2 bg-[#0f0f0f] rounded p-2 border border-[#1a1a1a]">
                        <pre className="text-[#9ca3af] text-[10px] font-mono overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(call.arguments, null, 2)}
                        </pre>
                      </div>
                    </details>
                  ))}
                </div>
              )}

              {/* Tool results */}
              {turn.toolResults.length > 0 && (
                <div className="flex flex-col gap-1">
                  {turn.toolResults.map((result, resultIdx) => (
                    <details key={resultIdx} className="group">
                      <summary className="flex items-center gap-2 cursor-pointer list-none text-xs py-1">
                        <span className="text-[#9ca3af] uppercase text-[10px]">Result</span>
                        <span className="text-[#6b7280]">{result.toolCallId.slice(0, 8)}</span>
                        <span className="text-[#6b7280] group-open:rotate-180 transition-transform ml-auto">▼</span>
                      </summary>
                      <div className="mt-2 bg-[#0f0f0f] rounded p-2 border border-[#1a1a1a]">
                        <p className="text-[#6b7280] text-[11px] whitespace-pre-wrap break-words">
                          {truncate(result.text, 300)}
                        </p>
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
