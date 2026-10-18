import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => ({ rpc: { bootstrap: vi.fn() } }));
vi.mock("./performance", () => ({ markOnce: vi.fn() }));

import { rpc } from "./rpc";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("bootstrap upload configuration", () => {
  it.each([undefined, 2 * 1024 * 1024, 25 * 1024 * 1024])(
    "uses the server limit %s with an older-server fallback",
    async (maxUploadSizeBytes) => {
      vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
      vi.mocked(rpc.bootstrap).mockResolvedValue({
        me: { ticketBoardEnabled: false, maxUploadSizeBytes },
      } as Awaited<ReturnType<typeof rpc.bootstrap>>);
      const { takeInitialBootstrap, getMaxUploadSizeBytes } = await import("./bootstrap");
      await takeInitialBootstrap();
      expect(getMaxUploadSizeBytes()).toBe(maxUploadSizeBytes ?? 10 * 1024 * 1024);
    },
  );
});

describe("switching spaces in place", () => {
  it("loads the other space under its own header and leaves it for the shell", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    const other = { me: { ticketBoardEnabled: false } } as Awaited<
      ReturnType<typeof rpc.bootstrap>
    >;
    vi.mocked(rpc.bootstrap).mockReset().mockResolvedValue(other);
    const { primeSpaceBootstrap, takeInitialBootstrap } = await import("./bootstrap");
    await primeSpaceBootstrap("space-b", "bot-b");
    expect(rpc.bootstrap).toHaveBeenCalledWith(
      { botId: "bot-b" },
      { context: { spaceId: "space-b" } },
    );
    await expect(takeInitialBootstrap("bot-b")).resolves.toBe(other);
    expect(rpc.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("never hands a discarded switch's bootstrap to a later shell", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    vi.mocked(rpc.bootstrap)
      .mockReset()
      .mockResolvedValue({ me: { ticketBoardEnabled: false } } as Awaited<
        ReturnType<typeof rpc.bootstrap>
      >);
    const { discardPrimedBootstrap, primeSpaceBootstrap, takeInitialBootstrap } = await import(
      "./bootstrap"
    );
    const primed = primeSpaceBootstrap("space-b", "bot-b");
    discardPrimedBootstrap(primed);
    await takeInitialBootstrap("bot-b");
    expect(rpc.bootstrap).toHaveBeenLastCalledWith({ botId: "bot-b" });
    expect(rpc.bootstrap).toHaveBeenCalledTimes(2);
  });
});
