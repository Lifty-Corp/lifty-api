import { describe, expect, it, vi } from "vitest";

import { startService } from "../src/start-server.js";

describe("HTTP server bootstrap", () => {
  it("binds the production app to the configured host and port", () => {
    const server = { close: vi.fn() };
    const serve = vi.fn((_options: {
      fetch: (request: Request) => unknown;
      hostname: string;
      port: number;
    }) => server);

    const result = startService(
      {
        host: "127.0.0.1",
        port: 8787,
        publicBaseUrl: "https://api.lifty.test",
        supabase: {
          supabaseUrl: "https://project.supabase.test",
          publishableKey: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
          jwks: { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }] },
        },
        hubspot: {
          clientId: "client-123",
          clientSecret: "client-secret",
          publicBaseUrl: "https://api.lifty.test",
          supabaseUrl: "https://project.supabase.test",
          publishableKey: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
        },
        slack: {
          clientId: "slack-client-123",
          clientSecret: "slack-client-secret",
          publicBaseUrl: "https://api.lifty.test",
          supabaseUrl: "https://project.supabase.test",
          publishableKey: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
        },
        trigger: {
          apiUrl: "https://api.trigger.test",
          secretKey: "tr_prod_test_key",
        },
        notificationsTrigger: {
          apiUrl: "https://notifications.trigger.test",
          secretKey: "tr_prod_notifications_test_key",
        },
      },
      serve,
    );

    expect(result).toBe(server);
    expect(serve).toHaveBeenCalledOnce();
    expect(serve).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "127.0.0.1", port: 8787 }),
    );
    expect(serve.mock.calls[0]?.[0]?.fetch).toBeTypeOf("function");
  });
});
