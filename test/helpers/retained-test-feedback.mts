import { performance } from "node:perf_hooks";

export const RETAINED_CASE_MARKER = "[foundry-retained-case:v1]";

const stages = ["checkout", "frozen-install", "cli-version", "original-suite", "cleanup"] as const;
type RetainedStage = (typeof stages)[number];
export interface RetainedStageFeedback {
  readonly stage: RetainedStage;
  readonly boundary: "start" | "end";
  readonly elapsed_ms: number;
  readonly error_kind: ReturnType<typeof classifyRetainedError> | null;
}

export function measureRetainedStage<T>(
  stage: RetainedStage,
  action: () => T,
  emit: (record: RetainedStageFeedback) => void,
): T {
  if (!stages.includes(stage)) throw new Error("Unknown retained test stage");
  const start = performance.now();
  const observe = (boundary: RetainedStageFeedback["boundary"], error: unknown = null) => {
    try {
      emit({
        stage,
        boundary,
        elapsed_ms: boundary === "start" ? 0 : Math.max(0, performance.now() - start),
        error_kind: error === null ? null : classifyRetainedError(error),
      });
    } catch {
      // Capture failures never replace or qualify the original command result.
    }
  };
  observe("start");
  try {
    const result = action();
    observe("end");
    return result;
  } catch (error) {
    observe("end", error);
    throw error;
  }
}

const caseNames = {
  "public native draft repair accepts a bound save_draft contract without extra dispatch":
    "native-draft-normal",
  "public native draft repair lost response recovers by readback without replay":
    "native-draft-lost-response",
  "public native draft repair rejects an impossible operation/before binding before dispatch":
    "native-draft-invalid-binding",
} as const;

type CaseLabel = (typeof caseNames)[keyof typeof caseNames];
export type RetainedCasePhase = {
  readonly stage: "original-suite";
  readonly case: CaseLabel;
  readonly boundary: "start" | "end";
  readonly elapsed_ms: number;
};

export function retainedCaseLabel(name: string): CaseLabel | null {
  return Object.hasOwn(caseNames, name) ? caseNames[name as keyof typeof caseNames] : null;
}

export function readRetainedCasePhases(
  first: string,
  second = "",
): {
  phases: RetainedCasePhase[];
  omission: "none" | "absent" | "invalid" | "oversized";
} {
  if (Buffer.byteLength(first, "utf8") + Buffer.byteLength(second, "utf8") + 1 > 65_536)
    return { phases: [], omission: "oversized" };
  const value = first + "\n" + second;
  const phases: RetainedCasePhase[] = [];
  const expected = Object.values(caseNames).flatMap((label) => [
    [label, "start"] as const,
    [label, "end"] as const,
  ]);
  for (const line of value.split(/\r?\n/u)) {
    if (!line.startsWith(RETAINED_CASE_MARKER)) continue;
    try {
      if (line.length > 512 || phases.length >= 6) throw new Error("Invalid phase record");
      const item: unknown = JSON.parse(line.slice(RETAINED_CASE_MARKER.length));
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("Invalid phase record");
      const row = item as Record<string, unknown>;
      const expectation = expected[phases.length];
      if (
        !expectation ||
        Object.keys(row).sort().join(",") !== "boundary,case,elapsed_ms,stage" ||
        row.stage !== "original-suite" ||
        row.case !== expectation[0] ||
        row.boundary !== expectation[1] ||
        typeof row.elapsed_ms !== "number" ||
        !Number.isFinite(row.elapsed_ms) ||
        row.elapsed_ms < 0 ||
        row.elapsed_ms > 1_000_000 ||
        row.elapsed_ms < (phases.at(-1)?.elapsed_ms ?? 0)
      )
        throw new Error("Invalid phase record");
      phases.push({
        stage: "original-suite",
        case: expectation[0],
        boundary: expectation[1],
        elapsed_ms: row.elapsed_ms,
      });
    } catch {
      return { phases: [], omission: "invalid" };
    }
  }
  return { phases, omission: phases.length ? "none" : "absent" };
}

export function classifyRetainedError(
  error: unknown,
): "timeout" | "spawn-error" | "assertion" | "other" {
  let code: unknown;
  try {
    code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return "other";
  }
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "ERR_ASSERTION") return "assertion";
  return typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "ENOBUFS"].includes(code)
    ? "spawn-error"
    : "other";
}
