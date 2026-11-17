import path from "node:path";
import { createFileArtifactFact } from "@tiangong-lca/cli/command-spec";
import { readNativeDraftHandoff } from "./finalize-owners/native-draft-handoff.ts";
import { buildEdgeSupportPlan } from "./foundry-edge-support-plan.ts";
import {
  captureFoundryInput,
  FoundryContextError,
  readFoundryInput,
  resolveFoundryOutput,
  type FoundryInputFact,
  type FoundryRuntimeContext,
} from "./foundry-runtime-context.ts";
import { workflowObject } from "./foundry-workflow-state.ts";
import { readRows, repoRelativePath } from "./import-curation/internal/runtime-io.ts";

type JsonRecord = Record<string, unknown>;

/** Build the guarded Edge handoff from the exact approved repair and its retained preflight. */
export function createFoundryRepairHandoffPlan(input: {
  context: FoundryRuntimeContext;
  candidateFile: string;
  beforeFile: string;
  contract: FoundryInputFact;
  preparation: FoundryInputFact;
  outDir: string;
}): JsonRecord {
  const { context } = input;
  const account = context.accountIntent;
  if (!account) throw new Error("A repair handoff plan requires the current account intent.");
  const relativePath = (file: string) => repoRelativePath(input.context.assetRoot, file);
  const native = readNativeDraftHandoff({
    contractFile: input.contract.path,
    rowsFile: input.candidateFile,
    datasetType: "process",
    targetUserId: account.userId,
    verifiedProjectRef: account.projectRef,
    stateCode: "0",
    relativePath,
  });
  const approved = createFileArtifactFact({
    role: "final_rows",
    path: relativePath(input.candidateFile),
    filePath: input.candidateFile,
  });
  if (native.rows_sha256 !== approved.sha256)
    throw new Error(
      "--execution-contract-file repair candidate rows changed during handoff admission.",
    );
  const contract = captureFoundryInput(input.contract.path);
  const preparation = captureFoundryInput(input.preparation.path);
  const before = captureFoundryInput(input.beforeFile);
  const read = (file: string) => readFoundryInput(context, file).toString("utf8");
  const preparedEvidence = workflowObject(
    workflowObject(JSON.parse(read(preparation.path))).evidence,
  );
  const preflight = Array.isArray(preparedEvidence.detail)
    ? preparedEvidence.detail.map(workflowObject).find((item) => item.role === "edge_preflight")
    : undefined;
  const ruleVerification = workflowObject(
    workflowObject(preflight?.report ?? {}).rule_verification ?? {},
  );
  const dependencyFact = Array.isArray(preparedEvidence.files)
    ? preparedEvidence.files
        .map(workflowObject)
        .find((file) => file.role === "edge-repair:out/references/edge-support-precommit.json")
    : undefined;
  if (typeof dependencyFact?.path !== "string")
    throw new FoundryContextError(
      "repair_edge_scope_changed",
      "Guarded update requires the exact dependency report registered during preparation.",
    );
  const dependencies = resolveFoundryOutput(context, dependencyFact.path);
  const dependencyFile = captureFoundryInput(dependencies);
  if (
    dependencyFile.sha256 !== dependencyFact.sha256 ||
    dependencyFile.bytes !== dependencyFact.bytes
  )
    throw new FoundryContextError(
      "repair_edge_scope_changed",
      "The registered dependency report changed after preparation.",
    );
  const commit = buildEdgeSupportPlan(
    "process",
    captureFoundryInput(input.candidateFile),
    {
      project_ref: account.projectRef,
      user_id: account.userId,
    },
    readRows(input.candidateFile, read),
    {
      fact: dependencyFile,
      report: JSON.parse(read(dependencies)),
    },
    {
      binding: {
        before,
        contract,
        preparation,
        rule_verification: ruleVerification as Record<string, boolean>,
      },
      rows: readRows(before.path, read),
    },
  );
  const report: JsonRecord = {
    schema_version: 1,
    generated_at_utc: new Date().toISOString(),
    status: "ready_for_explicit_commit",
    dataset_type: "process",
    profile: "generic",
    remote_write_mode: "read-only",
    repair_scope: true,
    final_rows_file: input.candidateFile,
    final_rows_artifact: approved,
    target_user_id: account.userId,
    verified_project_ref: account.projectRef,
    account_mode: account.accountMode ?? "ordinary",
    expected_state_code: "0",
    execution_contract: { ...native.metadata },
    account_write_guard: {
      target_user_id: account.userId,
      commit_account_binding: "sealed_guarded_edge_update",
      execution_precondition:
        "Compare the exact reviewed before document inside the Edge save-draft transaction.",
    },
    policy: {
      commit_boundary:
        "The sealed owner attempt sends one guarded update and recovers exclusively through exact readback.",
      post_write_verify_required: true,
      compare_root_payload_required: true,
    },
    blockers: [],
    commands: { commit, post_write_verify: null },
    files: {
      expected_commit_report_dir: path.join(input.outDir, "commit"),
      expected_post_write_verify_dir: path.join(input.outDir, "post-write-verify"),
    },
  };
  return {
    ...report,
    files: {
      ...(report.files as JsonRecord),
      report: relativePath(path.join(input.outDir, "dataset-commit-handoff-plan.json")),
    },
  };
}
