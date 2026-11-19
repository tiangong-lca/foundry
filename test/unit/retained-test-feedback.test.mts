import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { command, isolatedEnvironment } from "../helpers/package-consumer-process.mts";
import {
  RETAINED_CASE_MARKER,
  classifyRetainedError,
  measureRetainedStage,
  readRetainedCasePhases,
} from "../helpers/retained-test-feedback.mts";

test("retained feedback accepts only bounded existing case observations", () => {
  const start = {
    stage: "original-suite",
    case: "native-draft-normal",
    boundary: "start",
    elapsed_ms: 12,
  };
  const end = { ...start, boundary: "end", elapsed_ms: 42 };
  const input = ["private service context", start, end]
    .map((value) =>
      typeof value === "string" ? value : RETAINED_CASE_MARKER + JSON.stringify(value),
    )
    .join("\n");
  assert.deepEqual(readRetainedCasePhases(input), {
    phases: [start, end],
    omission: "none",
  });
  for (const value of [
    { ...start, token: "private service context" },
    { ...start, case: "private service context" },
    { ...start, elapsed_ms: -1 },
    { ...start, elapsed_ms: Number.POSITIVE_INFINITY },
    { ...start, stage: "authentication" },
  ]) {
    const result = readRetainedCasePhases(RETAINED_CASE_MARKER + JSON.stringify(value));
    assert.deepEqual(result, { phases: [], omission: "invalid" });
    assert.doesNotMatch(JSON.stringify(result), /private service context|token/u);
  }
  assert.deepEqual(readRetainedCasePhases("private service context"), {
    phases: [],
    omission: "absent",
  });
  assert.deepEqual(readRetainedCasePhases("x".repeat(65_537)), {
    phases: [],
    omission: "oversized",
  });
  assert.deepEqual(readRetainedCasePhases(RETAINED_CASE_MARKER + "not-json"), {
    phases: [],
    omission: "invalid",
  });
  assert.deepEqual(readRetainedCasePhases("x".repeat(40_000), "x".repeat(40_000)), {
    phases: [],
    omission: "oversized",
  });
  assert.deepEqual(readRetainedCasePhases(RETAINED_CASE_MARKER + JSON.stringify(end)), {
    phases: [],
    omission: "invalid",
  });
});

test("retained feedback classifies errors without copying arbitrary context", () => {
  assert.equal(
    classifyRetainedError(Object.assign(new Error("private context"), { code: "ETIMEDOUT" })),
    "timeout",
  );
  assert.equal(
    classifyRetainedError(Object.assign(new Error("private context"), { code: "ENOENT" })),
    "spawn-error",
  );
  assert.equal(
    classifyRetainedError(Object.assign(new Error("private context"), { code: "ERR_ASSERTION" })),
    "assertion",
  );
  assert.equal(classifyRetainedError({ code: "private context" }), "other");
});

test("stage feedback retains the original error and omits arbitrary error context", () => {
  const records: unknown[] = [];
  const original = Object.assign(new Error("private service context"), { code: "ETIMEDOUT" });
  assert.throws(
    () =>
      measureRetainedStage(
        "original-suite",
        () => {
          throw original;
        },
        (record) => records.push(record),
      ),
    (error) => error === original,
  );
  assert.equal(records.length, 2);
  assert.doesNotMatch(JSON.stringify(records), /private service context/u);
  assert.match(JSON.stringify(records), /timeout/u);
  assert.throws(
    () =>
      measureRetainedStage(
        "original-suite",
        () => {
          throw original;
        },
        () => {
          throw new Error("capture failure");
        },
      ),
    (error) => error === original,
  );
});

test("command observation cannot rewrite failure or replace the original timeout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-retained-command-"));
  try {
    const env = isolatedEnvironment(path.join(root, "home"));
    let observed = false;
    const failed = command(
      process.execPath,
      ["-e", "process.exitCode=7"],
      root,
      env,
      120_000,
      (result) => {
        observed = true;
        assert.equal(result.status, 7);
        assert.ok(Object.isFrozen(result));
        assert.throws(() => {
          (result as { status: number }).status = 0;
        }, TypeError);
      },
    );
    assert.ok(observed);
    assert.equal(failed.status, 7);
    const failedObservation = command(
      process.execPath,
      ["-e", "process.exitCode=7"],
      root,
      env,
      120_000,
      () => {
        throw new Error("capture must not replace exit 7");
      },
    );
    assert.equal(failedObservation.status, 7);
    if (process.platform !== "win32") {
      const signalled = command(
        process.execPath,
        ["-e", "process.kill(process.pid,'SIGTERM')"],
        root,
        env,
        120_000,
        () => {
          throw new Error("capture must not replace signal failure");
        },
      );
      assert.equal(signalled.status, null);
      assert.equal(signalled.signal, "SIGTERM");
    }
    const partial = {
      stage: "original-suite",
      case: "native-draft-normal",
      boundary: "start",
      elapsed_ms: 1,
    };
    let timeoutFeedback: ReturnType<typeof readRetainedCasePhases> | undefined;
    assert.throws(
      () =>
        command(
          process.execPath,
          [
            "-e",
            `process.stderr.write(${JSON.stringify(RETAINED_CASE_MARKER + JSON.stringify(partial) + "\n")});setInterval(()=>{},1000)`,
          ],
          root,
          env,
          2_000,
          (result) => {
            timeoutFeedback = readRetainedCasePhases(result.stderr, result.stdout);
            throw new Error("observer must not replace timeout");
          },
        ),
      (error: unknown) =>
        !!error && typeof error === "object" && "code" in error && error.code === "ETIMEDOUT",
    );
    assert.deepEqual(timeoutFeedback, { phases: [partial], omission: "none" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Node preload observes existing cases without changing their outcomes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-retained-observer-"));
  try {
    const file = path.join(root, "original.test.mts");
    fs.writeFileSync(
      file,
      `import test from 'node:test';
test('public native draft repair accepts a bound save_draft contract without extra dispatch',()=>{});
test('public native draft repair lost response recovers by readback without replay',()=>{});
test('public native draft repair rejects an impossible operation/before binding before dispatch',()=>{});
test('private service context',()=>{});
`,
    );
    const observer = path.resolve(import.meta.dirname, "../helpers/retained-test-observer.mts");
    const result = command(
      process.execPath,
      ["--test", "--test-reporter=spec", "--import", pathToFileURL(observer).href, file],
      root,
      isolatedEnvironment(path.join(root, "home")),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ℹ pass 4$/mu);
    assert.match(result.stdout, /^ℹ skipped 0$/mu);
    const feedback = readRetainedCasePhases(result.stderr, result.stdout);
    assert.equal(feedback.omission, "none");
    assert.equal(feedback.phases.length, 6);
    assert.deepEqual(
      feedback.phases.map((phase) => phase.case),
      [
        "native-draft-normal",
        "native-draft-normal",
        "native-draft-lost-response",
        "native-draft-lost-response",
        "native-draft-invalid-binding",
        "native-draft-invalid-binding",
      ],
    );
    assert.doesNotMatch(JSON.stringify(feedback), /private service context/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the native test/preload chain retains a case start before the original spawn timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-retained-partial-"));
  try {
    const file = path.join(root, "finite.test.mts");
    fs.writeFileSync(
      file,
      "import test from 'node:test';test('public native draft repair accepts a bound save_draft contract without extra dispatch',()=>new Promise(resolve=>setTimeout(resolve,5000)));\n",
    );
    const observer = path.resolve(import.meta.dirname, "../helpers/retained-test-observer.mts");
    let feedback: ReturnType<typeof readRetainedCasePhases> | undefined;
    assert.throws(
      () =>
        command(
          process.execPath,
          ["--test", "--test-reporter=spec", "--import", pathToFileURL(observer).href, file],
          root,
          isolatedEnvironment(path.join(root, "home")),
          2_000,
          (result) => {
            feedback = readRetainedCasePhases(result.stderr, result.stdout);
          },
        ),
      (error: unknown) =>
        !!error && typeof error === "object" && "code" in error && error.code === "ETIMEDOUT",
    );
    assert.equal(feedback?.omission, "none");
    assert.equal(feedback?.phases[0]?.case, "native-draft-normal");
    assert.equal(feedback?.phases[0]?.boundary, "start");
  } finally {
    // This fixture has a finite timer even if its worker outlives the runner.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
