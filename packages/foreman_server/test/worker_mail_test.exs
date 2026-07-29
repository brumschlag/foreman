defmodule ForemanServer.WorkerMailTest do
  @moduledoc """
  Tests the worker Agent Mail endpoints.

  On the Pi path mail is a set of in-process tool closures over a live
  AgentMailClient. A kelos agent runs as a separate program in a separate pod, so
  it reaches the same mail store over HTTP instead — the store does not move, only
  the way the agent reaches it, mirroring `/worker/v1/tool-policy`.

  The load-bearing behaviour is the delivery transition. Before this existed,
  operator steering sat at `delivery_status: "unsupported"` forever because no
  worker could claim to receive it; a read that does not mark delivery would
  instead re-deliver the same steering on every check and leave the agent looping
  on stale instructions.
  """

  use ExUnit.Case
  import Plug.Conn
  import Plug.Test

  alias ForemanServer.Inbox

  @opts ForemanServer.Http.Router.init([])

  setup do
    tmp_dir =
      Path.join(System.tmp_dir!(), "foreman-mail-test-#{System.unique_integer([:positive])}")

    File.mkdir_p!(tmp_dir)

    Application.stop(:foreman_server)
    Application.put_env(:foreman_server, :event_log_path, Path.join(tmp_dir, "events.term.log"))
    Application.put_env(:foreman_server, :auth_token, "secret")
    assert :ok = Application.start(:foreman_server)

    on_exit(fn ->
      Application.stop(:foreman_server)
      Application.delete_env(:foreman_server, :event_log_path)
      Application.delete_env(:foreman_server, :auth_token)
      File.rm_rf!(tmp_dir)
      Application.start(:foreman_server)
    end)

    seed_run()
    :ok
  end

  describe "GET /worker/v1/mail" do
    test "returns mail addressed to the asking agent" do
      queue_operator_message("msg-1", to: "developer", subject: "steering")

      assert %{"ok" => true, "mail" => [message]} =
               get_mail("run_id=run-mail&agent=developer")

      assert message["message_id"] == "msg-1"
      assert message["subject"] == "steering"
    end

    test "accepts mail addressed generically to the worker" do
      # Operator and Overwatch senders address `worker`/`foreman` when they do
      # not know the phase's agent name; that mail must still be delivered.
      queue_operator_message("msg-worker", to: "worker", subject: "generic")

      assert %{"mail" => [message]} = get_mail("run_id=run-mail&agent=developer")
      assert message["message_id"] == "msg-worker"
    end

    test "excludes mail addressed to a different agent" do
      queue_operator_message("msg-other", to: "qa", subject: "not-yours")

      assert %{"mail" => []} = get_mail("run_id=run-mail&agent=developer")
    end

    test "omits already-delivered mail when unread=true" do
      queue_operator_message("msg-read", to: "developer", subject: "once")

      assert %{"mail" => [_]} = get_mail("run_id=run-mail&agent=developer&unread=true")

      assert {:ok, _} =
               Inbox.update_delivery(%{
                 message_id: "msg-read",
                 run_id: "run-mail",
                 delivery_status: "delivered"
               })

      # Without this, the agent re-reads the same steering on every check.
      assert %{"mail" => []} = get_mail("run_id=run-mail&agent=developer&unread=true")
    end

    test "requires a run id" do
      conn =
        :get
        |> conn("/worker/v1/mail?agent=developer")
        |> put_req_header("authorization", "Bearer secret")
        |> ForemanServer.Http.Router.call(@opts)

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"]["code"] == "VALIDATION_FAILED"
    end

    test "rejects an unauthenticated read" do
      conn =
        :get
        |> conn("/worker/v1/mail?run_id=run-mail")
        |> ForemanServer.Http.Router.call(@opts)

      assert conn.status == 401
    end
  end

  describe "POST /worker/v1/mail/send" do
    test "appends a message from the worker" do
      conn =
        post_json("/worker/v1/mail/send", %{
          run_id: "run-mail",
          phase_id: "developer",
          from: "developer",
          to: "foreman",
          subject: "agent-error",
          body: "Cannot locate the target module"
        })

      assert conn.status == 202
      assert %{"ok" => true, "mail" => mail} = Jason.decode!(conn.resp_body)
      assert mail["from"] == "developer"
      assert mail["to"] == "foreman"
      assert mail["direction"] == "worker_to_operator"
      assert mail["body"] == "Cannot locate the target module"
    end

    test "requires a body" do
      conn = post_json("/worker/v1/mail/send", %{run_id: "run-mail", subject: "empty"})

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"]["code"] == "VALIDATION_FAILED"
    end

    test "rejects an unauthenticated send" do
      conn =
        :post
        |> conn("/worker/v1/mail/send", Jason.encode!(%{run_id: "run-mail", body: "hi"}))
        |> put_req_header("content-type", "application/json")
        |> ForemanServer.Http.Router.call(@opts)

      assert conn.status == 401
    end
  end

  describe "POST /worker/v1/mail/ack" do
    test "marks a queued message delivered" do
      queue_operator_message("msg-ack", to: "developer", subject: "steering")

      conn =
        post_json("/worker/v1/mail/ack", %{
          message_id: "msg-ack",
          run_id: "run-mail",
          delivery_status: "delivered"
        })

      assert conn.status == 202

      message = get_in(ForemanServer.ProjectionStore.snapshot(), [:inbox_messages, "msg-ack"])
      assert Map.get(message, :delivery_status) == "delivered"
    end

    test "reports an unknown message rather than inventing one" do
      conn =
        post_json("/worker/v1/mail/ack", %{
          message_id: "msg-nope",
          run_id: "run-mail",
          delivery_status: "delivered"
        })

      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["error"]["code"] == "NOT_FOUND"
    end
  end

  test "a worker can consume operator steering end to end" do
    # The whole point of the feature: an operator sends steering with
    # `foreman inbox send`, the pod-side shim reads it, and the delivery status
    # moves off "queued" so it is not re-read. Before this, the message was
    # stored as "unsupported" and no agent ever saw it.
    queue_operator_message("msg-e2e", to: "worker", subject: "overwatch steering")

    assert %{"mail" => [message]} = get_mail("run_id=run-mail&agent=developer&unread=true")
    assert message["message_id"] == "msg-e2e"

    assert post_json("/worker/v1/mail/ack", %{
             message_id: "msg-e2e",
             run_id: "run-mail",
             delivery_status: "delivered"
           }).status == 202

    assert %{"mail" => []} = get_mail("run_id=run-mail&agent=developer&unread=true")

    # And the worker can answer on the same channel.
    assert post_json("/worker/v1/mail/send", %{
             run_id: "run-mail",
             from: "developer",
             to: "foreman",
             subject: "progress",
             body: "Narrowed scope as instructed"
           }).status == 202
  end

  defp seed_run do
    append_event("ProjectRegistered", "project:proj-mail", %{
      project_id: "proj-mail",
      path: "/tmp/proj-mail"
    })

    append_event("TaskCreated", "task:task-mail", %{
      task_id: "task-mail",
      project_id: "proj-mail",
      title: "Mail"
    })

    append_event("RunStarted", "run:run-mail", %{
      run_id: "run-mail",
      task_id: "task-mail",
      phase_order: ["developer"]
    })
  end

  defp queue_operator_message(message_id, opts) do
    assert {:ok, _} =
             Inbox.send_operator_message(%{
               message_id: message_id,
               run_id: "run-mail",
               phase_id: "developer",
               from: "operator",
               to: Keyword.fetch!(opts, :to),
               subject: Keyword.fetch!(opts, :subject),
               body: "Focus on the reported failure only.",
               worker_supports_receiving: true
             })
  end

  defp get_mail(query) do
    conn =
      :get
      |> conn("/worker/v1/mail?#{query}")
      |> put_req_header("authorization", "Bearer secret")
      |> ForemanServer.Http.Router.call(@opts)

    assert conn.status == 200
    Jason.decode!(conn.resp_body)
  end

  defp post_json(path, payload) do
    :post
    |> conn(path, Jason.encode!(payload))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer secret")
    |> ForemanServer.Http.Router.call(@opts)
  end

  defp append_event(event_type, stream_id, payload) do
    ForemanServer.EventStore.append(%{
      stream_id: stream_id,
      event_type: event_type,
      payload: payload,
      metadata: %{
        correlation_id: Map.get(payload, :run_id) || Map.get(payload, :task_id) || stream_id,
        idempotency_key: "#{event_type}:#{System.unique_integer([:positive])}"
      }
    })
  end
end
