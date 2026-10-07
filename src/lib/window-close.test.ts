import { describe, expect, it } from "vitest";
import mainWindowCapability from "../../src-tauri/capabilities/default.json";

describe("main window close capability", () => {
  it("allows Tauri onCloseRequested to destroy the window after accepting a close", () => {
    // Tauri's onCloseRequested calls destroy() unless the handler prevents it.
    // Without this permission, both the title-bar X and taskbar Close do nothing.
    expect(mainWindowCapability.windows).toContain("main");
    expect(mainWindowCapability.permissions).toContain(
      "core:window:allow-destroy",
    );
  });
});
