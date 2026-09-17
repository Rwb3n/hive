`./README-explainer.md` is written. Here is every change, and why.

## Factual corrections (verified against `current-test-output.txt`)

**1. Stale test count.**
- Original (part-a.md): "path traversal, symlink, and prefix-confusion attempts are blocked, with **15/15 unit tests passing**."
- Corrected: "The current suite is **25 cases, 25 passing and 0 failing, run on both Windows and WSL Linux**."
- Why: the current run reports `25 passed, 0 failed` and `Run on both Windows (25/25) and WSL Linux (25/25)`. Part A's number was stale and made no cross-platform claim.

**2. Symlink coverage claim is unsupported.**
- Original (part-a.md): "path traversal, **symlink**, and prefix-confusion attempts are blocked."
- Corrected: symlink removed from the enforced list, and a new line added: "Not covered: the suite has no symlink case, so symlink resolution is untested and should not be counted as enforced until it is."
- Why: the current run enumerates its cases, and there is no symlink case among them. I did not claim symlinks are *broken* — only that the suite does not cover them, which is what the output supports. Worth a look: either the case was dropped, or the claim was always aspirational.

**3. Fail-closed abnormal paths were under-listed.**
- Original (part-a.md): "`HIVE_ROOM_ROOT` unset, an unparseable payload, and anything else it cannot reason about."
- Corrected: added "a room root that does not exist" to that list.
- Why: the run covers `nonexistent room root` as a distinct case. Part A's "Those paths are covered by tests" is now accurate to what is actually covered.

**4. Enforcement section expanded with the real coverage.**
- Added the concrete case list (`..` and deep traversal, absolute paths Windows- and POSIX-style, UNC paths, sibling rooms, `room-evil` vs `room`, `Glob`/`Grep` by path, multi-edit `edits[]`, cwd-relative paths, per-platform case sensitivity).
- Why: Part A asserted enforcement in the abstract while the test output had the specifics. The claims are now backed by named cases rather than by a bare pass count.

## Structural and editing changes

**5. Order.** Part A first, then Part B, unchanged in relative order — the room has to be defined before the runtime that launches agents into it. Sections were demoted from `##` to `###` under two new `##` headings ("Rooms and the boundary", "The runtime") so the whole document has one heading spine.

**6. Titles normalised.** "Part A — Rooms and the Boundary" and "Part B: The Runtime" (inconsistent separators, and both naming themselves as parts) were replaced by a single document title and two section headings with no "Part" framing.

**7. Intro added.** Two short paragraphs: what the document covers, and why the two halves are coupled.

**8. Duplication between the parts resolved.** `--settings` and `--strict-mcp-config` appeared in both — as enforcement mechanisms in A, as launch flags in B. The launch sequence now says "The first and last of those are how the boundary described above reaches the session" instead of re-explaining what they do.

**9. Transitions added at the two seams.**
- Launch sequence: `HIVE_ROOM_ROOT` is now named as one of the variables set on the invocation, tying Part B's mechanism to Part A's central variable, which Part B never mentioned by name.
- Measured cost: added that WSL isolation is the practical answer to the `--settings` merge limitation from Part A — the merge can't be prevented, but the config merged from can be kept small. These were the same issue described from two sides in the two parts.
- Signal contract: `transcript_path` now reads "the structured JSONL **kept outside the room**", connecting to Part A's statement that logs live outside the tree.

## Not changed

The "21 entries" `permissions.deny` count, the cost figures (23,000 tokens / $0.25 vs 6,200 / $0.069 and the 3.7× ratio), and the `claude --bg` finding have no overlap with the test output, so I had nothing to verify them against and left them as written. I found no contradictions between the two parts themselves — they were consistent where they touched.

Want me to publish this as a shareable page as well as the file?