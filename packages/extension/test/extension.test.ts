import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import { activate } from "../src/extension.js";
import { runSelfTest } from "../src/self-test.js";
import * as vscode from "vscode";

vi.mock("../src/self-test.js", () => ({ runSelfTest: vi.fn() }));
vi.mock("../src/database-editor.js", () => ({
  DATABASE_EDITOR: "kdbx.database",
  DatabaseEditorProvider: class {},
}));
vi.mock("vscode", async (importOriginal) => {
  const original = await importOriginal<typeof vscode>();
  return {
    ...original,
    version: "1.101.0",
    commands: { ...original.commands, registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
    window: {
      ...original.window,
      registerCustomEditorProvider: vi.fn(() => ({ dispose: vi.fn() })),
      withProgress: vi.fn(original.window.withProgress),
    },
  };
});

describe("compatibility self-test command", () => {
  const report = {
    vscode: "1.101.0",
    electron: "35.5.1",
    node: "22.15.1",
    platform: "darwin",
    arch: "arm64",
    baselineLagMs: 0,
    cases: [],
    maxEventLoopLagMs: 0,
  };
  let command: (options?: unknown) => unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runSelfTest).mockResolvedValue(report);
    const context: Pick<ExtensionContext, "subscriptions"> = { subscriptions: [] };
    activate(context as ExtensionContext);
    const registration = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find(([id]) => id === "kdbx.compatibilitySelfTest");
    if (!registration) throw new Error("Self-test command was not registered.");
    command = registration[1];
  });

  it("returns the quiet report without invoking notification UI", async () => {
    expect(await command({ quiet: true })).toBe(report);
    expect(runSelfTest).toHaveBeenCalledWith("1.101.0");
    expect(vscode.window.withProgress).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, { quiet: false }, { quiet: "true" }])(
    "retains progress and result notifications for interactive options %j",
    async (options) => {
      expect(await command(options)).toBe(report);
      expect(vscode.window.withProgress).toHaveBeenCalledOnce();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "Compatibility self-test passed 0 cases; max extension-host lag 0 ms.",
      );
    },
  );

  it("propagates a quiet self-test failure", async () => {
    vi.mocked(runSelfTest).mockRejectedValue(new Error("synthetic probe failure"));
    await expect(command({ quiet: true })).rejects.toThrow("synthetic probe failure");
    expect(vscode.window.withProgress).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});
