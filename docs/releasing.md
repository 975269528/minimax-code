# Releasing a source preview

Public npm `latest` for `@minimax-ai/code` was 0.4.12 on 2026-09-18. This phase prepares the 0.4.12 GitHub source preview while keeping workspace/local build manifests `private: true` to prevent accidental npm publication. The source version follows the reviewed product baseline; checking registry metadata does not publish or validate an npm release. Record the exact source commit and archive receipt; version alignment alone does not establish provenance equivalence with the existing tarball.

The current GitHub repository is a **private review repository**. Older commits include a case later replaced with synthetic data. Do not switch this repository directly to public or carry those old commits or private review reports into public history. After PR review, export committed source from a checkout with no tracked changes:

```bash
node scripts/export-source-preview.mjs --out /private/release/minimax-code-source.tar.gz
```

The script validates the committed source inventory and exports an archive with a SHA-256 receipt from the current Git tree. It excludes `.git`, old commits, untracked files, caches, and user profiles. It does not push, publish, or overwrite existing artifacts. Extract and scan the archive outside the repository. After the publication decision is recorded for the candidate, import that snapshot onto a branch based on the existing public destination history, following the procedure below.

1. Complete the [publication authorization record](publication-authorization.md) for the exact candidate and verify the [maintainer handoff](maintainers.md#release-handoff). Confirm rights-holder authorization for the publication scope and first-party license. Confirm the first-party copyright attribution in the MIT `LICENSE` and `NOTICE`. Preserve third-party and package licenses; never copy a vendor-specific copyright statement into the project root. A public package manifest proves provenance, not authorization to publish previously private source.
2. Check `git status`, all release commits' authors / committers, and refs. Exclude internal history, backup refs, and user data. Inspect identities with `git log --all --format='%h %an <%ae> | %cn <%ce>'`.
3. Run `pnpm check:source` and review the public inventory, dependency licenses, and native helper hashes. Scan complete history rather than only the latest diff:

   ```bash
   gitleaks git --redact --log-opts=--all --report-format json --report-path /private/review/history.json
   git archive HEAD -o /private/review/source.tar
   ```

   Extract source into a separate directory and run `gitleaks dir --redact`; scan build artifacts separately. Keep reports outside the repository. Disclose finding rules, locations, and remediation without exposing credential values. Explain false positives by exact path, rule, and context; do not exclude entire test or asset directories.
4. In a clean directory, run frozen install, type checking, build, boundary checks, and the explicit test list. Wait for the macOS / Windows / Linux Node.js 24 checks, then explicitly run `Node compatibility` on the selected revision to cover all supported versions. Local macOS success is not acceptance evidence for other systems.
5. Use a temporary project and synthetic inputs for live-service checks. Record login, Token Plan / BYOK sessions, search / tools, resume, plugins, connectors, and sandbox results. Mark unavailable accounts or third-party grants as NOT RUN; fixtures do not replace service evidence. Confirm costs and upload scope separately for media generation, deployment, and feedback uploads.
6. After PR approval and publication authorization, create a prerelease tag and notes pointing to the verified public commit. State the capability baseline, installation steps, and untested areas. Publish the source archive, not a local `dist` directory or user profile presented as a cross-platform installer.

Before npm or binary distribution, separately validate update installation, package name / version, native dependency packaging, installation scripts, and complete notices. A dependency license declaration inventory is not a collection of all license texts required in an installer.

## Automated source candidates

Source candidates are explicit release-preparation runs, separate from ordinary PR and main-branch verification. Select `Source candidate` in the Actions UI and dispatch it on the reviewed branch or tag. The dispatch resolves that ref to the event's immutable commit SHA; every checkout, archive receipt and platform report uses that revision. The existing reusable entry also accepts a caller-supplied full revision. Ordinary code pushes, documentation changes and dependency PRs do not create candidates automatically.

For changes to the candidate/export workflow itself, dispatch a candidate on the PR branch and review its reports before merging. Also run `Node compatibility` explicitly for changes to supported Node versions, native dependencies or compatibility-sensitive verification tooling, and before a source release. Match the recorded run SHAs to the final candidate; a branch name may move after a dispatch. Candidate runs are grouped by revision and do not cancel an in-progress validation when another main-branch commit arrives.

The reusable `Source candidate` workflow exports that commit without Git history, checks its SHA-256 receipt, and scans complete history and the exact extracted source. Three fresh runners (Linux, macOS and Windows, Node 24) authenticate the same archive, extract it outside the checkout, install from public npm into a new pnpm store, and run `pnpm verify --profile archive`. This profile runs all applicable gates except re-exporting from Git, since the candidate intentionally contains no `.git`. The Linux build also receives a distribution secret scan. Platform-inapplicable tests remain explicitly marked as skipped; these automated checks do not replace live-service acceptance.

Only after all three validation jobs pass does the final job publish the `source-candidate-<full-SHA>` Actions artifact, retained for 14 days. It contains:

- `minimax-code-source.tar.gz`: the reviewed source snapshot.
- Its `.json` receipt and `.sha256` checksum file.
- `candidate.json`: the exact revision, archive digest, and three-platform validation summary.
- `reports/`: each platform's detailed verification JSON and Markdown.

The intermediate `unverified-source-<full-SHA>` artifact is retained for one day and must not be treated as a validated candidate. Candidate generation does not create a GitHub Release, publish to npm, change repository visibility, or grant publication rights. The authorization and history-free public-release requirements above still apply. GitHub must know the workflow on the default branch before its manual entry is available. When introducing this entry, validate the declaration and shared archive tooling in the PR, then dispatch it after the workflow becomes available; do not claim candidate acceptance until the three-platform run and artifact readback finish.

## Import into the existing public repository

The destination is [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code). It already hosts desktop-app issue reporting. Preserve its history, existing issues, desktop download links, and support workflows when adding the CLI source.

A GitHub squash merge only controls the resulting base-branch commit. Pushing a private source branch to a public repository exposes its reachable history before that merge. Do not push the private review branch, mirror its refs, or use an unrelated-history merge. Import the reviewed history-free archive as files on a fresh branch based on the destination's `main`, then open a PR and squash that public import PR.

### Before creating the public import PR

1. Freeze the reviewed source commit. Decide whether each open dependency update belongs in that candidate; do not incorporate unverified dependency upgrades just to clear the PR queue.
2. Run `pnpm verify` from a clean committed checkout. Require successful final-revision source verification, release audit, explicitly dispatched Node compatibility, and the validated three-platform `source-candidate-<full-SHA>` artifact. Check current runner annotations if jobs fail before starting; earlier local or historical passes do not replace these results.
3. Review and scan the exact exported files and record the source revision, archive SHA-256, public inventory digest, and validation reports. Complete the existing publication authorization record for that material scope before exposing the snapshot in a public branch or PR.
4. Prepare the destination integration in a local checkout. Preserve and extend its desktop bug / feature / question templates and `.github/workflows/sync-issue-to-feishu.yml`; retain the prepared Desktop / CLI product selector. The Chinese README is `README_ZH.md`; update active links to this path and remove the destination's superseded `README.zh-CN.md` during import.
5. Replace active clone, support, and administration examples with the destination repository. Keep historical verification URLs identifiable as historical evidence. Use official production documentation links. Explain that this source distribution contains the TUI, headless CLI, and ACP implementation; it does not publish the desktop application's source.
6. Verify destination settings: allow squash merges, configure `verification` and `source-history-artifact` as required checks, require independent review and resolved conversations, and prevent force pushes or deletion of the default branch. Assign reviewers with actual repository access. Enable private vulnerability reporting or verify a staffed private contact. Review Actions permissions and the existing support-workflow secret configuration without copying credentials into files.
7. The combined destination tree includes files absent from the source inventory. Review those additions and regenerate `release/public-source.json` with `node scripts/source-inventory.mjs --write`; review the generated diff. Run full verification and source/artifact scans on the integrated candidate too. A validated source archive does not establish validation of a subsequently modified integration tree.

### Import and readback

- Record both the reviewed source revision and the destination base revision. Keep private approval evidence, scan reports and local review pages outside the public file inventory.
- Extract the authenticated archive outside both repositories. Apply its reviewed files to the destination-based branch, resolving overlapping README and `.github` content individually. Do not bulk-delete destination-only files.
- Before committing, compare the staged file bytes and modes with the reviewed snapshot. Vendored Office XML schemas are marked non-normalizing in `.gitattributes` so Git does not silently change their CRLF bytes during import.
- Commit only the intended integration tree using public author/committer identities and an English message. Check that all new commits reachable from the import branch consist only of reviewed import work on top of the destination base.
- After authorization and local review, push that branch and open the destination PR. Re-run checks against its final head, obtain independent review, and squash merge through the PR.
- Read back the merged PR, resulting commit, default-branch tree, documentation links and checks. Record the import commit as the public synchronization baseline while retaining `release/extraction.json` for the separate shared-source baseline. Source synchronization continues through reviewed three-way candidates; the squash import does not replace that contract.
- An npm release, installer update or GitHub Release is a separate action with its own validation. Do not infer a package publication from a merged source PR.


### Prepared destination compatibility

The private review tree includes the public destination's three established issue-form paths and its Feishu support workflow, imported from destination revision `cd025375799a1360d499d5c06cfb2e1111a960fc`. The forms now route Desktop, TUI, headless, ACP and source-build reports explicitly; Desktop upload IDs are optional and do not apply to CLI reports. The existing source-only bug and feature forms were consolidated into these destination paths to avoid duplicate choices. The documentation issue form remains available.

The Feishu workflow retains the destination's payload and delivery behavior and runs only for issue-open events in the public `MiniMax-AI/minimax-code` repository. It cannot forward issues from this private review repository. Its existing `FEISHU_BOT_WEBHOOK` and optional `FEISHU_BOT_SECRET` must remain configured on the destination; secret values are not copied, and preparation tests must not send notifications. Offline tests exercise payload generation with synthetic issue data.

The Chinese README uses a single entry, `README_ZH.md`; the destination's superseded `README.zh-CN.md` is intentionally removed during import. Both main READMEs retain Desktop download and support links while explaining the CLI-only source scope. Before import, compare the destination against the recorded revision again: later destination changes need review rather than replacement by this prepared snapshot.

Repository description proposal: **MiniMax Code CLI source and Desktop support — terminal coding agent, headless automation, and ACP.** Website: `https://agent.minimax.io/docs/cli/quick-start`. Apply these to the public destination only as part of the authorized publication operation.
