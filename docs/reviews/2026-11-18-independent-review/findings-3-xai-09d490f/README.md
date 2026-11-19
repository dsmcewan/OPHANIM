# Assignment 3: grok-4.7

Reviewed commit: `09d490feae4df80effa081d08a02ea240f3dc854`. Runner status: **incomplete**. Transport: **grok-cli**.

The findings document and transcript belong to this reviewer only. Source transcript hash verification passed before export. The raw originals remain at the source paths recorded in `run-summary.json`.

Files under `reproductions/.review-tests/` were recovered from this reviewer's retained file capture, with their hashes checked. They were not rerun during packaging. Copy the `.review-tests/` directory into a disposable checkout before running the commands cited in the findings. A `.partial` suffix means the original capture was truncated.

CLI records identify the model requested at launch; they do not prove a provider-returned served-model identity. A completed report is not an approval or acceptance.

The native Grok CLI ended normally with `stopReason: end_turn`. The pinned runner did not recognize its `type: text, data: ...` stream, so the original runner report and transcript remain marked incomplete. Read `grok-assignment-3-recovered-final.md` for the verbatim public final message, joined from the retained text chunks without edits. `grok-assignment-3-recovery.json` records the extraction and hashes. The earlier authenticated leg is preserved under `continuation/`. No thought events were used in the recovered final document, and no rerun was needed solely to recover its text.

`grok-parser-diagnostic.json` reproduces the parser returning no final text on the retained native final events, without a provider call.
