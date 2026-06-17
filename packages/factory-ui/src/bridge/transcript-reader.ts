/**
 * TranscriptReader
 *
 * Reads the JSONL log file for a run and builds a ChatTurn[] array
 * representing the full agent conversation (LLM turns, tool calls, tool results).
 */

import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatToolResult {
  toolCallId: string;
  text: string;
}

export interface ChatTurn {
  role: "assistant" | "tool_result";
  text: string;          // assistant narrative text (empty for tool_result turns)
  toolCalls: ChatToolCall[];
  toolResults: ChatToolResult[];
  usage?: { input: number; output: number; cost: { total: number } };
}

const LOGS_DIR = join(homedir(), ".foreman", "logs");

export class TranscriptReader {
  /** Reads the log file for the given runId and returns parsed ChatTurn[]. */
  async read(runId: string): Promise<ChatTurn[]> {
    const logPath = join(LOGS_DIR, `${runId}.log`);
    
    // Read entire file
    let content: string;
    try {
      content = await this.readFile(logPath);
    } catch {
      return [];
    }

    // Split by newline, filter JSON lines
    const lines = content.split("\n").filter((line) => line.trim().startsWith("{"));
    
    // Parse and filter message_end events
    const messageEndEvents: { type: string; message: any }[] = [];
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "message_end") {
          messageEndEvents.push(parsed);
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    // Build ChatTurn[] from message_end events
    const turns: ChatTurn[] = [];
    let lastAssistantTurn: ChatTurn | null = null;

    for (const event of messageEndEvents) {
      const message = event.message;
      const role = message.role as string;

      if (role === "assistant") {
        // Extract text and tool calls from content
        const contentArray = message.content || [];
        let text = "";
        const toolCalls: ChatToolCall[] = [];

        for (const item of contentArray) {
          if (item.type === "text") {
            text += item.text;
          } else if (item.type === "toolCall") {
            toolCalls.push({
              id: item.id,
              name: item.name,
              arguments: item.arguments || {},
            });
          }
        }

        // Extract usage if available
        const usage = message.usage
          ? {
              input: message.usage.input || 0,
              output: message.usage.output || 0,
              cost: { total: message.usage.cost?.total || 0 },
            }
          : undefined;

        // Create new assistant turn
        lastAssistantTurn = {
          role: "assistant",
          text,
          toolCalls,
          toolResults: [],
          usage,
        };
        turns.push(lastAssistantTurn);
      } else if (role === "user" && lastAssistantTurn) {
        // Check for tool results in user message
        const contentArray = message.content || [];
        const hasToolResults = contentArray.some(
          (item: any) => item.type === "toolResult"
        );

        // Skip user messages that are only text (like system prompts)
        // Only process if there are tool results
        if (hasToolResults) {
          const toolResults: ChatToolResult[] = [];

          for (const item of contentArray) {
            if (item.type === "toolResult") {
              // Extract text from tool result content
              const resultContent = item.content || [];
              const resultText = resultContent
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n");

              toolResults.push({
                toolCallId: item.toolCallId,
                text: resultText,
              });
            }
          }

          // Attach tool results to the previous assistant turn
          lastAssistantTurn.toolResults = toolResults;
        }
      }
      // Skip message_update events (already handled above) and other types
    }

    return turns;
  }

  private readFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let content = "";
      const stream = createReadStream(path, { encoding: "utf-8" });

      stream.on("data", (chunk) => {
        content += chunk;
      });

      stream.on("end", () => {
        resolve(content);
      });

      stream.on("error", (err) => {
        reject(err);
      });
    });
  }
}
