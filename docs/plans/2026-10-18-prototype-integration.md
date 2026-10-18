# Combined prototype integration

Fresh worktree from main e007b2f. Preserve immutable reviewed heads of PRs37–42 via local merge commits, without merging their GitHub PRs or changing main. Existing plans remain the feature contracts. Resolve shared shell/styles/vocabulary/journal conflicts while preserving every panel and notebook key.

Acceptance: all six new prototypes coexist with existing views; navigating away cancels obsolete receipt work and playback, entering a self-contained prototype closes shared detail, dirty notebook text survives navigation, and the attention strip remains available. Navigation must remain scrollable at small window heights. Test these observable integration seams before fixing gaps, using existing captured fixtures. Do not redesign existing features or infer new evidence.

Validation: full frontend tests/build; gofmt/vet/full tests/build; sidecar and Rust tests; isolated actual-daemon browser navigation across all views. Parallel spec and standards review of immutable integrated head. Requested Argon4 High or Sonnet5.5 High review remains a draft gate while account quota is unavailable. Preserve individual PR review evidence; combined verification does not replace their pending gates. Publish integration as draft and document PR dependencies, exact tests and limitations in HTML journal. Main merges still need human authorization.
