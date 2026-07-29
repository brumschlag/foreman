defmodule ForemanServer.Http.Endpoint do
  @moduledoc "Bandit child spec for the Foreman HTTP API."

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts \\ []) do
    port = Keyword.get(opts, :port, http_port())
    ip = Keyword.get(opts, :ip, bind_ip())
    validate_remote_access!(ip)

    Bandit.child_spec(
      plug: ForemanServer.Http.Router,
      scheme: :http,
      ip: ip,
      port: port,
      startup_log: false
    )
  end

  @doc """
  Bind address for the HTTP listener, defaulting to loopback.

  A container or pod must bind beyond loopback to be reachable through a
  published port or Service. The auth-token guard in `child_spec/1` still
  applies, so widening the bind cannot skip authentication.
  """
  @spec bind_ip() :: :inet.ip_address()
  def bind_ip do
    configured =
      Application.get_env(:foreman_server, :http_bind) ||
        System.get_env("FOREMAN_SERVER_HTTP_BIND")

    case configured do
      nil ->
        {127, 0, 0, 1}

      value when is_tuple(value) ->
        value

      value when is_binary(value) ->
        case :inet.parse_address(String.to_charlist(value)) do
          {:ok, ip} -> ip
          {:error, _} -> {127, 0, 0, 1}
        end
    end
  end

  defp validate_remote_access!(ip) do
    if remote_bind?(ip) and not ForemanServer.Security.token_configured?() do
      raise ArgumentError,
            "FOREMAN_SERVER_AUTH_TOKEN is required when binding the Elixir server beyond loopback"
    end
  end

  defp remote_bind?({127, _, _, _}), do: false
  defp remote_bind?({0, 0, 0, 0}), do: true
  defp remote_bind?({0, 0, 0, 0, 0, 0, 0, 0}), do: true
  defp remote_bind?({0, 0, 0, 0, 0, 0, 0, 1}), do: false
  defp remote_bind?(_ip), do: true

  defp http_port do
    ForemanServer.RuntimeInfo.http_port()
  end
end
