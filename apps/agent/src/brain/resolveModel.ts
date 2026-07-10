/** Map plan names → currently available OpenAI model ids. */
export function resolveDecisionModel(raw: string | null | undefined): string {
  const env = process.env.LUCRE_DECISION_MODEL?.trim();
  if (env) return env;
  const m = (raw ?? "gpt-4.1").toLowerCase();
  if (m.includes("terra") || m === "gpt-5.6-terra") return "gpt-5";
  if (m.includes("sol") || m === "gpt-5.6-sol") return "gpt-5";
  if (m === "gpt-5.6") return "gpt-5";
  return raw || "gpt-4.1";
}
