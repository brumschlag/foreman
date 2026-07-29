defmodule ForemanServer.PhaseReports do
  @moduledoc """
  Storage for phase reports uploaded by out-of-process workers.

  A kelos phase runs in its own pod and returns its work as a git patch of the
  repository. A report written to Foreman's reports directory therefore cannot
  travel — that path does not exist in the pod — so the artifact gate failed runs
  whose agents had all succeeded.

  Workers upload reports through `POST /worker/v1/reports` instead, and the server
  writes them where the existing filesystem-based artifact gate already looks.
  """

  @doc """
  Writes one report and returns its absolute path.

  A worker is untrusted input, so every path segment is validated to a single
  plain name: a traversing `file_name` or id would otherwise let a worker write
  anywhere the server can reach.
  """
  @spec store(map()) :: {:ok, String.t()} | {:error, term()}
  def store(input) when is_map(input) do
    with {:ok, root} <- required_binary(input, "reports_root"),
         {:ok, project_id} <- plain_segment(input, "project_id"),
         {:ok, task_id} <- plain_segment(input, "task_id"),
         {:ok, run_id} <- plain_segment(input, "run_id"),
         {:ok, file_name} <- plain_segment(input, "file_name"),
         {:ok, content} <- required_binary(input, "content") do
      dir = Path.join([root, project_id, task_id, run_id])
      path = Path.join(dir, file_name)

      with :ok <- File.mkdir_p(dir),
           # Truncating, not appending: a retried phase must replace its report
           # rather than accumulate both attempts.
           :ok <- File.write(path, content) do
        {:ok, path}
      end
    end
  end

  @doc "Default reports root, matching where the Node worker writes them."
  @spec default_root() :: String.t()
  def default_root do
    Path.join([home_dir(), ".foreman", "reports"])
  end

  defp home_dir do
    System.get_env("FOREMAN_HOME") || System.get_env("HOME") || "/tmp"
  end

  defp required_binary(input, key) do
    case Map.get(input, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_or_invalid, String.to_atom(key)}}
    end
  end

  # A valid segment is one plain path component: no separators, no traversal, no
  # absolute path. Compared against Path.basename so "a/../b" cannot slip through
  # by normalising to something harmless-looking.
  defp plain_segment(input, key) do
    with {:ok, value} <- required_binary(input, key) do
      if value == Path.basename(value) and value not in [".", ".."] and
           not String.contains?(value, ["/", "\\", "\0"]) do
        {:ok, value}
      else
        {:error, {:missing_or_invalid, String.to_atom(key)}}
      end
    end
  end
end
