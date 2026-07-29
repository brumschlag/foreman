defmodule ForemanServer.Http.EndpointTest do
  use ExUnit.Case, async: false

  alias ForemanServer.Http.Endpoint

  setup do
    original_bind = System.get_env("FOREMAN_SERVER_HTTP_BIND")
    original_token = Application.get_env(:foreman_server, :auth_token)

    on_exit(fn ->
      if is_nil(original_bind) do
        System.delete_env("FOREMAN_SERVER_HTTP_BIND")
      else
        System.put_env("FOREMAN_SERVER_HTTP_BIND", original_bind)
      end

      if is_nil(original_token) do
        Application.delete_env(:foreman_server, :auth_token)
      else
        Application.put_env(:foreman_server, :auth_token, original_token)
      end
    end)

    :ok
  end

  test "defaults to loopback when no bind address is configured" do
    System.delete_env("FOREMAN_SERVER_HTTP_BIND")

    assert Endpoint.bind_ip() == {127, 0, 0, 1}
  end

  test "parses an IPv4 bind address from the environment" do
    System.put_env("FOREMAN_SERVER_HTTP_BIND", "0.0.0.0")

    assert Endpoint.bind_ip() == {0, 0, 0, 0}
  end

  test "falls back to loopback on an unparseable bind address" do
    System.put_env("FOREMAN_SERVER_HTTP_BIND", "not-an-ip")

    assert Endpoint.bind_ip() == {127, 0, 0, 1}
  end

  test "a configured non-loopback bind requires an auth token" do
    System.put_env("FOREMAN_SERVER_HTTP_BIND", "0.0.0.0")
    Application.delete_env(:foreman_server, :auth_token)

    assert_raise ArgumentError, ~r/FOREMAN_SERVER_AUTH_TOKEN is required/, fn ->
      Endpoint.child_spec(port: 0)
    end
  end

  test "a configured non-loopback bind is used when a token is present" do
    System.put_env("FOREMAN_SERVER_HTTP_BIND", "0.0.0.0")
    Application.put_env(:foreman_server, :auth_token, "container-secret")

    assert %{start: {Bandit, :start_link, [opts]}} = Endpoint.child_spec(port: 0)
    assert Keyword.fetch!(opts, :ip) == {0, 0, 0, 0}
  end
end
