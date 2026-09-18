# Publication authorization record

Status: **PENDING rights-holder confirmation**. This document prepares a reviewable decision; it is not authorization to publish. On 2026-09-12 the repository owner supplied **MiniMax Code** as the first-party copyright attribution; it is recorded in the root `NOTICE`. Authorization to publish the exact candidate and each material group below remains pending.

## Proposed publication scope

Publish a source preview from the committed, reviewed file inventory in `release/public-source.json`, using the history-free export procedure in [Releasing](releasing.md). The first-party default and workspace package declarations use MIT. Third-party and file-level exceptions remain intact, including Apache-2.0 for `third_party/sandbox-runtime` and the original MIT notices for Pi and the bundled DOCX skill.

| Material | Review required | Decision |
| --- | --- | --- |
| First-party code in the reviewed package roots, build/release scripts and tests | Identify the rights holder and confirm publication under the existing applicable declarations | PENDING |
| First-party prompts, agents, skills, templates, examples and documentation | Confirm ownership/provenance, permission to redistribute and removal of private or personal material | PENDING |
| MiniMax names, logos, screenshots, demo recordings and other brand assets | Confirm that the specific assets may be included and describe any separate brand-use terms | PENDING |
| Vendored Pi and Sandbox Runtime; derived terminal code and model catalog | Retain upstream licenses, copyright and modification notices; review the exact included materials | Existing notices retained; final release review PENDING |
| Downloaded mcode-tools artifact and npm dependencies | Retain their own terms and applicable notices; do not treat their public availability as first-party source authorization | Declared provenance recorded; final distribution review PENDING |

The approval must cover the exact candidate, not an unspecified future branch. Untracked working files, private review reports, account data, internal Git history and later additions are outside this scope. Approval for source publication does not approve npm publishing, installer distribution, third-party account access or paid service operations.

## Rights-holder decision to record

An authorized representative must supply the following before the release owner marks this record approved:

- First-party attribution supplied by the repository owner: **MiniMax Code**, recorded in `NOTICE`. The authorized representative must confirm that attribution as part of the publication decision.
- Approver identity, authority to act for that holder, decision date and a non-sensitive reference to the approval. Keep confidential legal evidence outside the public repository.
- Reviewed candidate commit, exported archive SHA-256 and public inventory SHA-256 from the release receipt/review.
- Explicit approval or exclusions for each material group above, including package/file license exceptions and brand assets.
- Any conditions that must be completed before publication.

Current publication decision: **not recorded**. The supplied attribution is recorded; no approval date, authority or approval reference has been inferred. After confirmation, update this record; preserve the MIT text and maintain consistent project attribution in `LICENSE` and `NOTICE`. If the candidate changes afterward, review the changed scope and record a new approval or an explicitly authorized scope-preserving update.

## Release-owner checks

The release owner in [Maintainers](maintainers.md) verifies that the decision and candidate match, preserves all third-party notices, and links the approved record from the release notes. [License status](../LICENSE-STATUS.md) must agree with this record. Authorization alone does not replace CI, source/history/artifact scanning or the requirement to exclude private history when importing onto the existing public destination history.
