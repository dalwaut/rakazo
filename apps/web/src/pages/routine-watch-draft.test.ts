import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));

import { emptyWatchDraft, watchFromDraft } from "./RoutineEditor";

describe("watchFromDraft", () => {
  it("splits paths by line and drops blanks", () => {
    const result = watchFromDraft({ ...emptyWatchDraft(), paths: " inbox/ \n\nreports/a.csv\n" });
    expect(result).toEqual({
      watch: { kind: "files", everyMinutes: 15, loud: false, paths: ["inbox/", "reports/a.csv"] },
    });
  });

  it("parses tool arguments as a JSON object", () => {
    const draft = { ...emptyWatchDraft(), kind: "tool" as const, tool: "brain_changed" };
    expect(watchFromDraft({ ...draft, args: '{"limit":1}' })).toMatchObject({
      watch: { tool: "brain_changed", args: { limit: 1 } },
    });
    expect(watchFromDraft({ ...draft, args: "[1]" })).toHaveProperty("error");
    expect(watchFromDraft({ ...draft, args: "{nope" })).toHaveProperty("error");
  });

  it("refuses an empty watch", () => {
    expect(watchFromDraft(emptyWatchDraft())).toHaveProperty("error");
    expect(watchFromDraft({ ...emptyWatchDraft(), kind: "command" })).toHaveProperty("error");
  });
});
