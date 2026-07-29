defmodule ForemanServer.PhaseReportsTest do
  use ExUnit.Case, async: false

  alias ForemanServer.PhaseReports

  # A kelos phase runs in its own pod. Its patch carries only the repo diff, so a
  # report written to Foreman's reports directory — which does not exist in the pod
  # — can never travel. The documentation phase's artifact gate then failed a run
  # whose agents had all succeeded.
  #
  # Reports therefore upload through /worker/v1, and the server writes them where
  # the filesystem-based artifact gate already looks.
  setup do
    root = Path.join(System.tmp_dir!(), "foreman-reports-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(root) end)
    {:ok, root: root}
  end

  # FOREMAN_HOME already points AT the .foreman directory (see
  # src/lib/foreman-paths.ts), so appending ".foreman" again would write to
  # ~/.foreman/.foreman/reports — a path the Node-side artifact gate never reads.
  # Caught before deploying by comparing the two path builders.
  test "default_root matches where the Node worker's gate looks" do
    System.put_env("FOREMAN_HOME", "/home/foreman/.foreman")
    on_exit(fn -> System.delete_env("FOREMAN_HOME") end)

    assert PhaseReports.default_root() == "/home/foreman/.foreman/reports"
  end

  test "writes a report under the run's reports directory", %{root: root} do
    assert {:ok, path} =
             PhaseReports.store(%{
               "reports_root" => root,
               "project_id" => "proj",
               "task_id" => "task-1",
               "run_id" => "run-1",
               "file_name" => "DOCUMENTATION_REPORT.md",
               "content" => "# Documentation Report\n\n## Verdict: PASS\n"
             })

    assert path == Path.join([root, "proj", "task-1", "run-1", "DOCUMENTATION_REPORT.md"])
    assert File.read!(path) =~ "Verdict: PASS"
  end

  test "rejects a file name that escapes the reports directory", %{root: root} do
    # A worker is untrusted input: a traversing name would let it write anywhere
    # the server can reach.
    for name <- ["../escape.md", "a/../../escape.md", "/etc/passwd", "sub/dir.md"] do
      assert {:error, {:missing_or_invalid, :file_name}} =
               PhaseReports.store(%{
                 "reports_root" => root,
                 "project_id" => "proj",
                 "task_id" => "task-1",
                 "run_id" => "run-1",
                 "file_name" => name,
                 "content" => "x"
               }),
             "expected #{name} to be rejected"
    end
  end

  test "rejects traversal in the id segments", %{root: root} do
    assert {:error, {:missing_or_invalid, :task_id}} =
             PhaseReports.store(%{
               "reports_root" => root,
               "project_id" => "proj",
               "task_id" => "../../etc",
               "run_id" => "run-1",
               "file_name" => "R.md",
               "content" => "x"
             })
  end

  test "requires the identifying fields", %{root: root} do
    base = %{
      "reports_root" => root,
      "project_id" => "proj",
      "task_id" => "task-1",
      "run_id" => "run-1",
      "file_name" => "R.md",
      "content" => "x"
    }

    for key <- ["project_id", "task_id", "run_id", "file_name", "content"] do
      assert {:error, {:missing_or_invalid, _}} = PhaseReports.store(Map.delete(base, key)),
             "expected a missing #{key} to be rejected"
    end
  end

  test "overwrites on retry so a repeated phase is not appended to", %{root: root} do
    args = %{
      "reports_root" => root,
      "project_id" => "proj",
      "task_id" => "task-1",
      "run_id" => "run-1",
      "file_name" => "QA_REPORT.md",
      "content" => "first"
    }

    {:ok, path} = PhaseReports.store(args)
    {:ok, ^path} = PhaseReports.store(%{args | "content" => "second"})

    assert File.read!(path) == "second"
  end
end
