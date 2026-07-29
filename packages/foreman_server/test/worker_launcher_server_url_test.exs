defmodule ForemanServer.WorkerLauncherServerUrlTest do
  use ExUnit.Case, async: false

  # server_url/0 hardcoded http://127.0.0.1:<port>, which is correct only while the
  # launcher and the server share a network namespace. A kelos agent runs in its own
  # pod, so the URL handed to its PreToolUse policy hook resolved to the agent
  # container itself and every tool call was denied with "policy endpoint
  # unavailable" — the gate failing closed against a URL that could never work.
  setup do
    original = System.get_env("FOREMAN_SERVER_URL")

    on_exit(fn ->
      if is_nil(original) do
        System.delete_env("FOREMAN_SERVER_URL")
      else
        System.put_env("FOREMAN_SERVER_URL", original)
      end
    end)

    :ok
  end

  test "prefers FOREMAN_SERVER_URL so out-of-pod workers can reach the server" do
    System.put_env(
      "FOREMAN_SERVER_URL",
      "http://foreman-server.kelos-pilot.svc.cluster.local:4766"
    )

    assert ForemanServer.WorkerLauncher.server_url() ==
             "http://foreman-server.kelos-pilot.svc.cluster.local:4766"
  end

  test "falls back to loopback when no URL is configured" do
    System.delete_env("FOREMAN_SERVER_URL")

    assert ForemanServer.WorkerLauncher.server_url() ==
             "http://127.0.0.1:#{ForemanServer.RuntimeInfo.http_port()}"
  end

  test "ignores a blank value rather than handing out an empty URL" do
    System.put_env("FOREMAN_SERVER_URL", "   ")

    assert ForemanServer.WorkerLauncher.server_url() =~ "127.0.0.1"
  end
end
