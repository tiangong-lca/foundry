import { inspectFoundryRelease, readFoundryReleaseGit as git } from "./foundry-release-contract.ts";

/** Inspect the PR delta actually exercised by this checkout. Release callers keep their explicit base. */
export function inspectFoundryCiPullRequest(
  root: string,
  source: string,
  env: Readonly<NodeJS.ProcessEnv>,
) {
  const eventBase = env.FOUNDRY_CI_BASE_SHA ?? "";
  if (env.GITHUB_ACTIONS !== "true") return inspectFoundryRelease(root, eventBase, source);

  const eventHead = env.FOUNDRY_CI_PR_HEAD_SHA ?? "";
  const number = env.FOUNDRY_CI_PR_NUMBER ?? "";
  const baseRepo = env.FOUNDRY_CI_PR_BASE_REPO_ID ?? "";
  const oid = /^[a-f0-9]{40}$/u;
  if (
    env.GITHUB_EVENT_NAME !== "pull_request" ||
    env.FOUNDRY_CI_SOURCE_SHA ||
    !oid.test(source) ||
    !oid.test(eventBase) ||
    !oid.test(eventHead) ||
    !/^[1-9]\d*$/u.test(number) ||
    !/^[1-9]\d*$/u.test(baseRepo) ||
    baseRepo !== env.GITHUB_REPOSITORY_ID ||
    source !== env.GITHUB_SHA ||
    source !== git(root, ["rev-parse", "HEAD"]).trim()
  )
    throw new Error("PR comparison requires the exact checkout and its event identities.");

  if (env.GITHUB_REF !== `refs/pull/${number}/merge`) {
    if (
      source === eventHead &&
      (env.GITHUB_REF === `refs/pull/${number}/head` ||
        (env.GITHUB_HEAD_REF && env.GITHUB_REF === `refs/heads/${env.GITHUB_HEAD_REF}`))
    )
      return inspectFoundryRelease(root, eventBase, source);
    throw new Error("PR comparison ref does not match the event and checkout.");
  }

  const parents = git(root, ["show", "-s", "--format=%P", source]).trim().split(" ");
  if (parents.length !== 2 || !oid.test(parents[0]) || parents[1] !== eventHead)
    throw new Error("Tested PR merge must have the event head as its second parent.");
  const testedBase = parents[0];
  // The event can retain an older base after the head incorporates a release already on Main.
  if (eventBase !== testedBase) git(root, ["merge-base", "--is-ancestor", eventBase, testedBase]);
  return inspectFoundryRelease(root, testedBase, source);
}
