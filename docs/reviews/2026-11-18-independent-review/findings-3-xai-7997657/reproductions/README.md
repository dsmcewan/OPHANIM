# Retained Grok reproduction tests

These four files were authored by Grok while reviewing `7997657e77d597c6dfda8b7d971d0e4499c88b3a`. They were recovered verbatim from the saved provider responses. No test was rerun for this handoff.

Copy `.review-tests/` into a disposable checkout of the reviewed commit before running the commands cited by the report. Their imports assume that original location. `PROVENANCE.json` ties each file to its source response and records the observed test exits. Three test runs exited 1 and one exited 0; an exit 1 alone does not distinguish an intended defect reproduction from a fixture error.

The original disposable worktree was removed by the runner. Preserve the original report and transcript when validating or fixing any finding at a newer commit.
