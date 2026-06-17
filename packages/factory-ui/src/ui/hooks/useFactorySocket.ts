import { useEffect, useRef } from "react";
import { useFactoryStore } from "../store/factoryStore";
import type { FactoryWsMessage } from "../../bridge/types";

const WS_URL = "ws://localhost:4747";
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];

export function requestTranscript(runId: string): void {
  const ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    ws.send(JSON.stringify({ kind: "transcript_request", data: { runId } }));
    ws.close();
  };
  ws.onerror = () => {
    // Silently fail if WS is not available
  };
}

export function useFactorySocket() {
  const store = useFactoryStore();
  const attemptRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let mounted = true;

    function connect() {
      if (!mounted) return;
      store.setConnectionStatus("connecting");
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as FactoryWsMessage;
          switch (msg.kind) {
            case "connected":
              store.setConnectionStatus("connected");
              store.setProjectId(msg.data.projectId);
              break;
            case "pipeline_event":
              store.addEvent(msg.data);
              break;
            case "runs_snapshot":
              store.setRuns(msg.data);
              break;
            case "tasks_snapshot":
              store.setTasks(msg.data);
              break;
            case "stats_snapshot":
              store.setStats(msg.data);
              break;
            case "config_snapshot":
              store.setConfig(msg.data);
              break;
            case "log_line":
              store.addLogLine(msg.data);
              break;
            case "processes_snapshot":
              store.setProcesses(msg.data);
              break;
            case "transcript_snapshot":
              store.setTranscript(msg.data.runId, msg.data.turns);
              break;
            case "error":
              console.error("[ws] bridge error:", msg.data.message);
              break;
          }
        } catch (err) {
          console.error("[ws] parse error:", err);
        }
      };

      ws.onclose = () => {
        if (!mounted) return;
        store.setConnectionStatus("disconnected");
        const delay = BACKOFF[Math.min(attemptRef.current, BACKOFF.length - 1)];
        attemptRef.current++;
        timerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose fires after onerror — let it handle reconnect
        store.setConnectionStatus("disconnected");
      };
    }

    connect();

    return () => {
      mounted = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
