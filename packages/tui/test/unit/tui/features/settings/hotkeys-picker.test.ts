import { describe, expect, it, vi } from "vitest";
import { TuiHotkeysPicker } from "../../../../../src/tui/features/settings/hotkeys-picker.js";
import { createTuiHostKeybindings } from "../../../../../src/tui/shell/keybindings.js";

function createPicker(
  initial: Record<string, string | string[]> = {},
  saveUserOverrides = vi.fn(async () => undefined),
) {
  let current = { ...initial };
  const keybindings = createTuiHostKeybindings({
    platform: "linux",
    suspendSupported: true,
    userOverrides: initial,
  });
  const picker = new TuiHotkeysPicker({
    registry: keybindings.registry,
    getUserOverrides: () => ({ ...current }),
    saveUserOverrides: async (next) => {
      await saveUserOverrides(next);
      current = { ...next } as typeof current;
      keybindings.manager.setUserBindings({
        ...keybindings.hostOverrides,
        ...current,
      });
    },
    onClose: vi.fn(),
  });
  return { picker, saveUserOverrides, keybindings };
}

describe("TuiHotkeysPicker", () => {
  it("captures and saves a new key for the selected action", async () => {
    const { picker, saveUserOverrides, keybindings } = createPicker();

    picker.handleInput("\r");
    picker.handleInput("\x0b");
    picker.handleInput("\r");

    await vi.waitFor(() => expect(saveUserOverrides).toHaveBeenCalledOnce());
    expect(saveUserOverrides).toHaveBeenCalledWith({
      "composer.toggle-plan": "ctrl+k",
    });
    expect(picker.render(120).join("\n")).toContain("Ctrl+K");
    expect(
      keybindings.registry.resolve("\x0b", {
        interactionActive: false,
        hasLiveRun: false,
      }),
    ).toBe("toggle-plan");
  });

  it("rejects a conflicting key before persisting it", async () => {
    const { picker, saveUserOverrides } = createPicker();

    picker.handleInput("\r");
    picker.handleInput("\x0f");
    picker.handleInput("\r");

    await Promise.resolve();
    expect(saveUserOverrides).not.toHaveBeenCalled();
    expect(picker.render(120).join("\n")).toContain("Conflict: ctrl+o");
  });

  it("supports clearing and restoring the selected action", async () => {
    const saveUserOverrides = vi.fn(async () => undefined);
    const { picker } = createPicker(
      { "composer.toggle-plan": "ctrl+k" },
      saveUserOverrides,
    );

    picker.handleInput("r");
    await vi.waitFor(() => expect(saveUserOverrides).toHaveBeenCalledWith({}));
    await vi.waitFor(() =>
      expect(picker.render(120).join("\n")).toContain(
        "Reset composer.toggle-plan to default.",
      ),
    );

    saveUserOverrides.mockClear();
    picker.handleInput("\r");
    picker.handleInput("\x7f");
    picker.handleInput("\r");
    await vi.waitFor(() =>
      expect(saveUserOverrides).toHaveBeenCalledWith({
        "composer.toggle-plan": [],
      }),
    );
  });
});
