defmodule ForemanServer.Release do
  @moduledoc """
  Release tasks callable without Mix.

  A `mix release` bundle has no Mix and no project source, so `mix ecto.migrate`
  is unavailable in the container. These entry points are invoked via
  `bin/foreman_server eval 'ForemanServer.Release.migrate()'`.
  """

  @app :foreman_server

  @spec migrate() :: :ok
  def migrate do
    load_app()

    for repo <- repos() do
      {:ok, _, _} =
        Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, migrations_path(), :up, all: true))
    end

    :ok
  end

  @spec rollback(module(), integer()) :: :ok
  def rollback(repo, version) do
    load_app()

    {:ok, _, _} =
      Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, migrations_path(), :down, to: version))

    :ok
  end

  @spec repos() :: [module()]
  def repos do
    load_app()
    Application.fetch_env!(@app, :ecto_repos)
  end

  @spec migrations_path() :: String.t()
  def migrations_path do
    Application.app_dir(@app, "priv/repo/migrations")
  end

  defp load_app do
    Application.load(@app)
  end
end
