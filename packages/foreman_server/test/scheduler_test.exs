defmodule ForemanServer.SchedulerTest.NoopLauncher do
  def launch(_task, run_id, phases), do: {:ok, %{run_id: run_id, phases: phases}}
end

defmodule ForemanServer.SchedulerTest do
  use ExUnit.Case

  alias ForemanServer.{EventStore, ProjectionStore, Scheduler}

  setup do
    tmp_dir =
      Path.join(System.tmp_dir!(), "foreman-scheduler-test-#{System.unique_integer([:positive])}")

    File.mkdir_p!(tmp_dir)

    Application.stop(:foreman_server)
    Application.put_env(:foreman_server, :event_log_path, Path.join(tmp_dir, "events.term.log"))

    Application.put_env(:foreman_server, :scheduler,
      auto_tick: false,
      event_triggered_ticks: false,
      worker_launcher: ForemanServer.SchedulerTest.NoopLauncher
    )

    assert :ok = Application.start(:foreman_server)

    on_exit(fn ->
      Application.stop(:foreman_server)
      Application.delete_env(:foreman_server, :event_log_path)
      Application.delete_env(:foreman_server, :scheduler)
      File.rm_rf!(tmp_dir)
      Application.start(:foreman_server)
    end)

    :ok
  end

  test "tick claims ready tasks and records run start without synthetic phases" do
    create_task("task-a", %{project_id: "alpha", status: "ready"})

    assert {:ok, %{claimed: [%{task_id: "task-a", run_id: run_id}], skipped: []}} =
             Scheduler.tick(max_concurrent: 2, default_phases: ["dev", "qa"])

    assert run_id =~ ~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    assert ProjectionStore.snapshot().tasks["task-a"].status == "in_progress"

    assert [%{event_type: "RunStarted", payload: payload}] = EventStore.stream("run:#{run_id}")
    assert payload.phase_order == ["dev", "qa"]
    refute Enum.any?(EventStore.stream("run:#{run_id}"), &(&1.event_type == "PhaseStarted"))
  end

  test "global capacity leaves extra ready tasks queued and records skip reason" do
    create_task("task-a", %{project_id: "test", status: "ready"})
    create_task("task-b", %{project_id: "test", status: "ready"})

    assert {:ok, %{claimed: [%{task_id: "task-a"}], skipped: [%{task_id: "task-b"}]}} =
             ForemanServer.scheduler_tick(max_concurrent: 1)

    snapshot = ProjectionStore.snapshot()
    assert snapshot.tasks["task-b"].status == "ready"
    assert snapshot.scheduler_skips["task-b"].reason == "global_capacity_exhausted"
  end

  test "project capacity limits are enforced across scheduler callers" do
    create_task("alpha-1", %{project_id: "alpha", status: "ready"})
    create_task("alpha-2", %{project_id: "alpha", status: "ready"})
    create_task("beta-1", %{project_id: "beta", status: "ready"})

    assert {:ok, result} = Scheduler.tick(max_concurrent: 3, project_limits: %{"alpha" => 1})

    assert Enum.map(result.claimed, & &1.task_id) == ["alpha-1", "beta-1"]

    assert result.skipped == [
             %{task_id: "alpha-2", project_id: "alpha", reason: "project_capacity_exhausted"}
           ]

    snapshot = ProjectionStore.snapshot()
    assert snapshot.tasks["alpha-2"].status == "ready"
    assert snapshot.scheduler_skips["alpha-2"].reason == "project_capacity_exhausted"
  end

  test "periodic tick automatically claims ready tasks" do
    Application.stop(:foreman_server)

    Application.put_env(:foreman_server, :scheduler,
      auto_tick: true,
      event_triggered_ticks: false,
      tick_interval_ms: 20,
      worker_launcher: ForemanServer.SchedulerTest.NoopLauncher
    )

    assert :ok = Application.start(:foreman_server)

    create_task("task-auto", %{project_id: "alpha", status: "ready"})

    assert_receive_tick(fn -> ProjectionStore.snapshot().tasks["task-auto"].status end)
    run_id = ProjectionStore.snapshot().tasks["task-auto"].run_id
    assert [%{event_type: "RunStarted"}] = EventStore.stream("run:#{run_id}")
  end

  test "event appended to ready task stream triggers scheduler without projection polling tick" do
    Application.stop(:foreman_server)

    Application.put_env(:foreman_server, :scheduler,
      auto_tick: false,
      event_triggered_ticks: true,
      worker_launcher: ForemanServer.SchedulerTest.NoopLauncher
    )

    assert :ok = Application.start(:foreman_server)

    assert {:ok, _event} =
             ForemanServer.EventStore.append(%{
               stream_id: "task:task-event",
               event_type: "TaskCreated",
               payload: %{
                 task_id: "task-event",
                 title: "event task",
                 project_id: "alpha",
                 status: "ready"
               },
               metadata: %{correlation_id: "task-event", idempotency_key: "task-event-create"}
             })

    assert_receive_tick(fn -> ProjectionStore.snapshot().tasks["task-event"].status end)
    assert run_id = ProjectionStore.snapshot().tasks["task-event"].run_id
    assert [%{event_type: "RunStarted"}] = EventStore.stream("run:#{run_id}")
    assert Scheduler.state().last_event_id
  end

  # The Postgres read-model returns `updated_at` as a NaiveDateTime, but
  # age_seconds/2 only clause-matched nil, DateTime and binary. So every tick
  # raised FunctionClauseError inside active_runs/0, the Scheduler GenServer
  # terminated, and NO task could ever dispatch — with `last_tick: nil` making it
  # look like the scheduler had simply never run.
  test "tick survives a NaiveDateTime updated_at from the Postgres read model" do
    # active_runs/0 only inspects runs whose TASK is also in_progress, so the
    # task must be claimed first or the run is filtered out before age_seconds.
    create_task("task-naive", %{project_id: "alpha", status: "in_progress"})

    # A run whose updated_at is a NaiveDateTime, as the Postgres projection
    # returns it — not the ISO8601 string term mode happens to produce.
    assert {:ok, _} =
             EventStore.append(%{
               stream_id: "run:run-naive",
               event_type: "RunStarted",
               payload: %{
                 run_id: "run-naive",
                 task_id: "task-naive",
                 project_id: "alpha",
                 status: "in_progress",
                 updated_at: ~N[2026-07-29 03:20:33.881504]
               },
               metadata: %{correlation_id: "run-naive", idempotency_key: "run-naive-start"}
             })

    scheduler = Process.whereis(Scheduler)

    # The crash was inside the GenServer, so the tick call exits rather than
    # returning an error tuple. Assert on both: no raise, and still alive.
    assert {:ok, _result} = Scheduler.tick(max_concurrent: 2)
    assert Process.alive?(scheduler), "scheduler terminated on a NaiveDateTime updated_at"
    assert Process.whereis(Scheduler) == scheduler, "scheduler was restarted by its supervisor"
  end

  # Capacity was counted over ALL active runs while the `stale` flag the
  # scheduler already computes went unused, so a dead run held its slot forever.
  # On the pilot four abandoned runs (11-15h old) pinned max_concurrent: 2 and
  # had to be failed by hand before anything could dispatch.
  test "a stale active run does not hold a capacity slot" do
    create_task("task-dead", %{project_id: "alpha", status: "in_progress"})
    create_task("task-fresh", %{project_id: "alpha", status: "ready"})

    start_run("run-dead", "task-dead", hours_ago(12))

    assert {:ok, %{claimed: [%{task_id: "task-fresh"}], skipped: []}} =
             Scheduler.tick(max_concurrent: 1)
  end

  test "a stale run is still reported so the operator can see it" do
    create_task("task-dead", %{project_id: "alpha", status: "in_progress"})
    start_run("run-dead", "task-dead", hours_ago(12))

    assert {:ok, %{stale_active_runs: [%{run_id: "run-dead"}], active_runs: 1}} =
             Scheduler.tick(max_concurrent: 1)
  end

  # The other direction, and the reason this is not simply "ignore old runs":
  # WorkerHeartbeat does NOT bump run.updated_at — only phase transitions do — so
  # a long single phase looks stale by timestamp while its worker is alive and
  # working. Freeing that slot would double-dispatch the task.
  test "a long-running run with a recent heartbeat keeps its slot" do
    create_task("task-busy", %{project_id: "alpha", status: "in_progress"})
    create_task("task-queued", %{project_id: "alpha", status: "ready"})

    start_run("run-busy", "task-busy", hours_ago(12))
    heartbeat("run-busy", "worker-busy", DateTime.utc_now())

    assert {:ok, %{claimed: [], skipped: [%{reason: "global_capacity_exhausted"}]}} =
             Scheduler.tick(max_concurrent: 1)
  end

  defp hours_ago(hours), do: DateTime.add(DateTime.utc_now(), -hours * 3600, :second)

  defp start_run(run_id, task_id, updated_at) do
    assert {:ok, _} =
             EventStore.append(%{
               stream_id: "run:#{run_id}",
               event_type: "RunStarted",
               payload: %{
                 run_id: run_id,
                 task_id: task_id,
                 project_id: "alpha",
                 status: "in_progress",
                 updated_at: DateTime.to_iso8601(updated_at)
               },
               metadata: %{correlation_id: run_id, idempotency_key: "#{run_id}-start"}
             })
  end

  defp heartbeat(run_id, worker_id, observed_at) do
    assert {:ok, _} =
             EventStore.append(%{
               stream_id: "worker:#{run_id}:#{worker_id}",
               event_type: "WorkerHeartbeat",
               payload: %{
                 run_id: run_id,
                 worker_id: worker_id,
                 phase_id: "developer",
                 sequence: 1,
                 observed_at: observed_at
               },
               metadata: %{
                 correlation_id: run_id,
                 idempotency_key: "hb:#{run_id}:#{worker_id}:1"
               }
             })
  end

  defp assert_receive_tick(fun, attempts \\ 20)

  defp assert_receive_tick(fun, attempts) when attempts > 0 do
    if fun.() == "in_progress" do
      :ok
    else
      Process.sleep(10)
      assert_receive_tick(fun, attempts - 1)
    end
  end

  defp assert_receive_tick(_fun, 0), do: flunk("scheduler did not claim ready task")

  defp create_task(task_id, attrs) do
    payload = Map.merge(%{task_id: task_id, title: task_id}, attrs)

    assert {:ok, _} =
             ForemanServer.handle_command(%{
               command_id: "cmd-#{task_id}",
               command_type: "task.create",
               payload: payload
             })
  end
end
