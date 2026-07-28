defmodule ForemanServer.ReleaseTest do
  use ExUnit.Case, async: true

  alias ForemanServer.Release

  test "repos/0 lists the configured ecto repos" do
    assert Release.repos() == [ForemanServer.Repo]
  end

  test "migrations_path/0 resolves inside the compiled app's priv directory" do
    path = Release.migrations_path()

    assert path == Application.app_dir(:foreman_server, "priv/repo/migrations")
    assert File.dir?(path)
  end

  test "migrations_path/0 contains the versioned ecto migrations" do
    migrations = Path.wildcard(Path.join(Release.migrations_path(), "*.exs"))

    assert Enum.any?(migrations, &String.ends_with?(&1, "_create_event_store.exs"))
    assert Enum.any?(migrations, &String.ends_with?(&1, "_create_projection_read_models.exs"))
  end
end
