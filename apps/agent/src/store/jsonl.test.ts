import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RISK_CONFIG } from "@lucre/types";
import { openStore } from "./jsonl.js";

const dirs: string[] = [];

function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "lucre-test-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe("jsonl store", () => {
  it("append GENESIS and verify chain", async () => {
    const home = tempHome();
    const store = openStore(home);
    expect(store.load()).toEqual([]);

    const ev = await store.append({
      kind: "GENESIS",
      payload: {
        ownerLabel: "test",
        paper: true,
        risk: DEFAULT_RISK_CONFIG,
        startingCashCents: 100_00,
        decisionModel: "terra",
        screenModel: "mini",
        reviewModel: "sol",
      },
    });

    expect(ev.seq).toBe(1);
    expect(ev.prevHash).toBeNull();
    expect(ev.hash).toHaveLength(64);

    const v = store.verifyChain();
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.count).toBe(1);
      expect(v.tip).toBe(ev.hash);
    }

    const state = store.reduce();
    expect(state.cashCents).toBe(100_00);
    expect(state.initialized).toBe(true);
  });

  it("detects tampered line", async () => {
    const home = tempHome();
    const store = openStore(home);
    await store.append({
      kind: "GENESIS",
      payload: {
        ownerLabel: "test",
        paper: true,
        risk: DEFAULT_RISK_CONFIG,
        startingCashCents: 50_00,
        decisionModel: "t",
        screenModel: "s",
        reviewModel: "r",
      },
    });
    await store.append({
      kind: "RISK_HALTED",
      payload: { reason: "manual" },
    });

    // Tamper file: keep schema-valid payload, break content hash
    const { readFileSync, writeFileSync } = await import("node:fs");
    const raw = readFileSync(store.path, "utf8");
    const lines = raw.trim().split("\n");
    const second = JSON.parse(lines[1]!);
    second.payload.detail = "silent mutation";
    lines[1] = JSON.stringify(second);
    writeFileSync(store.path, lines.join("\n") + "\n");

    const v = store.verifyChain();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/hash mismatch/);
  });

  it("appendMany is sequential under one lock", async () => {
    const home = tempHome();
    const store = openStore(home);
    await store.append({
      kind: "GENESIS",
      payload: {
        ownerLabel: "test",
        paper: true,
        risk: DEFAULT_RISK_CONFIG,
        startingCashCents: 0,
        decisionModel: "t",
        screenModel: "s",
        reviewModel: "r",
      },
    });
    const many = await store.appendMany([
      { kind: "RISK_HALTED", payload: { reason: "manual" } },
      { kind: "RISK_RESUMED", payload: { note: "ok" } },
    ]);
    expect(many).toHaveLength(2);
    expect(many[0]!.seq).toBe(2);
    expect(many[1]!.seq).toBe(3);
    expect(many[1]!.prevHash).toBe(many[0]!.hash);
    expect(store.verifyChain().ok).toBe(true);
  });
});
