import { describe, expect, it, vi } from "vitest";
import type { McodeProviderView } from "../../src/provider/contract.js";
import { TuiProviderEditor } from "../../src/tui/features/provider/editor.js";
import { stripAnsi } from "../../src/tui/rendering/text.js";

const provider: McodeProviderView = {
  providerId: "custom_provider:work",
  name: "Work",
  kind: "custom",
  active: true,
  enabled: true,
  readOnly: false,
  hasApiKey: true,
  baseUrl: "https://models.example/v1",
  apiFormat: "openai-completions",
  configRevision: "rev-1",
  models: [{ modelId: "chat", selected: true }, { modelId: "reasoner" }],
};
function setup(onSave = vi.fn(async () => ({ success: true }))) {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const editor = new TuiProviderEditor({
    provider,
    onSave,
    onSaved,
    onCancel,
    requestRender: vi.fn(),
  });
  const save = () => {
    for (let i = 0; i < 4; i++) editor.handleInput("\u001b[B");
    editor.handleInput("\r");
  };
  return { editor, onSave, onSaved, onCancel, save };
}

describe("TuiProviderEditor", () => {
  it("omits unchanged credentials and models from the revision-checked update", async () => {
    const { save, onSave } = setup();
    save();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith({
      providerId: provider.providerId,
      expectedRevision: "rev-1",
      name: "Work",
      baseUrl: provider.baseUrl,
      apiFormat: "openai-completions",
      modelId: "chat",
      saveAndUse: false,
    });
  });

  it("retains the draft on test failure and redacts the replacement Key from errors", async () => {
    const onSave = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        status: { lastErrorMessage: "Rejected new-secret" },
      })
      .mockResolvedValueOnce({ success: true });
    const h = setup(onSave);
    h.editor.handleInput("\r");
    h.editor.handleInput("new-secret");
    h.editor.handleInput("\r");
    h.save();
    await vi.waitFor(() =>
      expect(stripAnsi(h.editor.render(200).join("\n"))).toContain(
        "Changes were not saved",
      ),
    );
    expect(h.onSaved).not.toHaveBeenCalled();
    expect(stripAnsi(h.editor.render(200).join("\n"))).not.toContain(
      "new-secret",
    );
    h.editor.handleInput("\r");
    await vi.waitFor(() => expect(h.onSaved).toHaveBeenCalledWith(true));
    expect(onSave.mock.calls[1]?.[0]).toEqual(onSave.mock.calls[0]?.[0]);
  });

  it("cancels a replacement without saving it", () => {
    const h = setup();
    h.editor.handleInput("\r");
    h.editor.handleInput("discarded-key");
    h.editor.handleInput("\u001b");
    h.editor.handleInput("\u001b");
    expect(h.onCancel).toHaveBeenCalledOnce();
    expect(h.onSave).not.toHaveBeenCalled();
    expect(stripAnsi(h.editor.render(100).join("\n"))).not.toContain(
      "discarded-key",
    );
  });

  it("validates the URL and persists an explicitly edited model list", async () => {
    const h = setup();
    h.editor.handleInput("\u001b[B");
    h.editor.handleInput("\r");
    h.editor.handleInput("\u0001");
    h.editor.handleInput("\u000b");
    h.editor.handleInput("ftp://invalid");
    h.editor.handleInput("\r");
    expect(stripAnsi(h.editor.render(120).join("\n"))).toContain(
      "Base URL must use http or https",
    );
    h.editor.handleInput("\u001b");
    h.editor.handleInput("\u001b[B");
    h.editor.handleInput("\r");
    h.editor.handleInput("\u0001");
    h.editor.handleInput("\u000b");
    h.editor.handleInput("chat, new-model, new-model");
    h.editor.handleInput("\r");
    h.editor.handleInput("\u001b[B");
    h.editor.handleInput("\u001b[B");
    h.editor.handleInput("\r");
    await vi.waitFor(() => expect(h.onSave).toHaveBeenCalledOnce());
    expect(h.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        models: [{ modelId: "chat" }, { modelId: "new-model" }],
        baseUrl: provider.baseUrl,
      }),
    );
  });

  it("does not reopen a disposed editor after a pending save", async () => {
    let resolve!: (result: { success: boolean }) => void;
    const h = setup(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    h.save();
    h.editor.dispose();
    resolve({ success: true });
    await Promise.resolve();
    expect(h.onSaved).not.toHaveBeenCalled();
  });
});
