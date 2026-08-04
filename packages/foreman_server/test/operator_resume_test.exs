defmodule ForemanServer.OperatorResumeTest do
  use ExUnit.Case

  alias ForemanServer.{EventStore, ProjectionStore}

  @moduledoc """
  A phase that calls `ask_operator` parks its run at `waiting_for_operator` and
  returns, which is right — it must not be re-dispatched as a failure. But nothing
  brought it back.

  `operator.resume` already exists as a command, appends `InteractiveRecoveryResumed`,
  and the projection records it — yet only into `interactive_recovery`, `phase_status`
  and `recovery_next_action`. None of those is read by anything, and neither the run
  nor the task leaves its parked status. The scheduler dispatches on TASK status and
  only `ready`/`approved` are dispatchable, so the run waits forever.

  These pin the projection half of the fix: a resume must return the run and its task
  to a state the scheduler will act on.
  """

  setup do
    tmp_dir =
      Path.join(
        System.tmp_dir!(),
        "foreman-operator-resume-test-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(tmp_dir)

    Application.stop(:foreman_server)
    Application.put_env(:foreman_server, :event_log_path, Path.join(tmp_dir, "events.term.log"))

    on_exit(fn ->
      Application.stop(:foreman_server)
      Application.delete_env(:foreman_server, :event_log_path)
      File.rm_rf!(tmp_dir)
      Application.start(:foreman_server)
    end)

    assert :ok = Application.start(:foreman_server)
    :ok
  end

  test "a resumed run leaves waiting_for_operator so it can be dispatched again" do
    seed_waiting_run()

    append!("operator:run-1", "InteractiveRecoveryResumed", %{
      run_id: "run-1",
      phase_id: "developer",
      next_action: "retry_phase",
      requested_by: "operator",
      status: "resume_requested"
    })

    run = get_in(ProjectionStore.snapshot(), [:runs, "run-1"])

    refute run.status == "waiting_for_operator",
           "a resumed run still parked at waiting_for_operator can never be re-dispatched"
  end

  test "a resumed run's task becomes dispatchable again" do
    seed_waiting_run()

    append!("operator:run-1", "InteractiveRecoveryResumed", %{
      run_id: "run-1",
      phase_id: "developer",
      next_action: "retry_phase",
      requested_by: "operator",
      status: "resume_requested"
    })

    task_ids = Enum.map(ProjectionStore.dispatchable_tasks(), & &1.task_id)

    assert "task-1" in task_ids,
           "the task stays blocked, so the scheduler never picks the resumed run back up"
  end

  test "an interruption alone does not make the task dispatchable" do
    seed_waiting_run()

    append!("operator:run-1", "HumanInterruptionRecorded", %{
      run_id: "run-1",
      phase_id: "developer",
      interrupted_by: "operator",
      reason: "operator_interrupt",
      next_action: "await_resume",
      status: "interrupted"
    })

    task_ids = Enum.map(ProjectionStore.dispatchable_tasks(), & &1.task_id)

    refute "task-1" in task_ids,
           "an interrupted run must stay parked until an operator actually resumes it"
  end

  # Seeds a task and run in the state ask_operator leaves behind: run parked at
  # waiting_for_operator, task parked at blocked.
  defp seed_waiting_run do
    append!("task:task-1", "TaskCreated", %{
      task_id: "task-1",
      title: "Add a subtract function",
      status: "ready",
      project_id: "proj-1"
    })

    append!("run:run-1", "RunStarted", %{
      run_id: "run-1",
      task_id: "task-1",
      project_id: "proj-1",
      status: "running"
    })

    append!("run:run-1", "RunUpdated", %{
      run_id: "run-1",
      task_id: "task-1",
      status: "waiting_for_operator"
    })

    append!("task:task-1", "TaskUpdated", %{
      task_id: "task-1",
      status: "blocked"
    })
  end

  defp append!(stream_id, event_type, payload) do
    {:ok, event} =
      EventStore.append(%{
        stream_id: stream_id,
        event_type: event_type,
        payload: payload,
        metadata: %{}
      })

    event
  end
end
