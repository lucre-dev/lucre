import { readFile } from "node:fs/promises";
import { sha256Hex } from "@lucre/core";
import { Mandate } from "@lucre/types";
import { lucreHome } from "../paths.js";
import { openStore } from "../store/jsonl.js";

/**
 * Import a ratified mandate JSON file → MANDATE_SET (or MANDATE_CHANGED).
 * Interactive interview is M3; this unblocks paper trading with a hand-written universe.
 */
export async function cmdMandateImport(opts: {
  file: string;
  home?: string;
  dryRun?: boolean;
}): Promise<void> {
  const home = opts.home ?? lucreHome();
  const store = openStore(home);
  const state = store.reduce();
  if (!state.initialized) {
    console.error("no GENESIS — run lucre init first");
    process.exitCode = 1;
    return;
  }

  const raw = await readFile(opts.file, "utf8");
  const json = JSON.parse(raw) as unknown;
  const mandate = Mandate.parse(json);
  const mandateHash = sha256Hex(raw);

  if (state.mandate === null) {
    if (mandate.version !== 1) {
      console.error("first mandate must be version 1");
      process.exitCode = 1;
      return;
    }
    const body = {
      kind: "MANDATE_SET" as const,
      payload: { mandate, mandateHash },
    };
    if (opts.dryRun) {
      console.log("dry-run MANDATE_SET", mandate.entries.map((e) => e.ticker));
      return;
    }
    const ev = await store.append(body);
    console.log(
      `MANDATE_SET v${mandate.version} seq=${ev.seq} · ${mandate.entries.length} tradable names`,
    );
    return;
  }

  const next = {
    ...mandate,
    version: state.mandateVersion + 1,
  };
  const body = {
    kind: "MANDATE_CHANGED" as const,
    payload: {
      mandate: next,
      mandateHash: sha256Hex(JSON.stringify(next)),
      basedOnVersion: state.mandateVersion,
      effectiveAt: null,
      diffSummary: `import from ${opts.file}`,
    },
  };
  if (opts.dryRun) {
    console.log("dry-run MANDATE_CHANGED → v", next.version);
    return;
  }
  const ev = await store.append(body);
  console.log(`MANDATE_CHANGED v${next.version} seq=${ev.seq}`);
}
