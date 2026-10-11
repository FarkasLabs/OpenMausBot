// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { WorkspaceYoloSettings } from "./WorkspaceYoloSettings";

const fixture = vi.hoisted(() => ({ config: { yolo: false }, allowed: true, api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.allowed }));
let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(WorkspaceYoloSettings)));
const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
const click = (button: HTMLButtonElement) => flushSync(() => button.click());
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(control => control.textContent === name)!;

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.config = { yolo: false };
  fixture.allowed = true;
  fixture.dispatch.mockImplementation((action: { type: string; config: { yolo: boolean } }) => { fixture.config = action.config; });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("WorkspaceYoloSettings", () => {
  it("requires the warning gesture and defaults focus to Cancel without saving", () => {
    render();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    click(toggle());
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("including existing and future threads");
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("destructive commands");
    expect(document.activeElement).toBe(button("Cancel"));
    click(button("Cancel"));
    expect(fixture.api).not.toHaveBeenCalled();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("saves the workspace setting once and displays only the server-confirmed state", async () => {
    fixture.api.mockResolvedValue({ yolo: true });
    render();
    click(toggle());
    click(button("Enable YOLO"));
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { yolo: true } }));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config/yolo", { method: "PUT", body: JSON.stringify({ enabled: true, confirmed: true }) });
    render();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    fixture.api.mockResolvedValue({ yolo: false });
    click(toggle());
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "configStatus", config: { yolo: false } }));
    render();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("does not confuse Advanced display mode with admin scope and shows refusal without changing state", async () => {
    fixture.allowed = false;
    render();
    expect(toggle().disabled).toBe(true);
    expect(host.textContent).toContain("Advanced display mode is not an admin role");
    fixture.allowed = true;
    fixture.api.mockRejectedValue(new Error("Sign in or pair an admin device first"));
    render();
    click(toggle());
    click(button("Enable YOLO"));
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe("Sign in or pair an admin device first"));
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });
});
