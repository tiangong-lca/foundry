import { writeSync } from "node:fs";
import { beforeEach, afterEach } from "node:test";
import { performance } from "node:perf_hooks";
import {
  RETAINED_CASE_MARKER,
  retainedCaseLabel,
  type RetainedCasePhase,
} from "./retained-test-feedback.mts";

const began = performance.now();
const write = writeSync;
function observe(name: string, boundary: RetainedCasePhase["boundary"]): void {
  const label = retainedCaseLabel(name);
  if (!label) return;
  const record: RetainedCasePhase = {
    stage: "original-suite",
    case: label,
    boundary,
    elapsed_ms: Math.max(0, performance.now() - began),
  };
  try {
    write(2, RETAINED_CASE_MARKER + JSON.stringify(record) + "\n");
  } catch {
    // Missing observation is not success and must not replace the original test outcome.
  }
}

beforeEach((context) => observe(context.name, "start"));
afterEach((context) => observe(context.name, "end"));
