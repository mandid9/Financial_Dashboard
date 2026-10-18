<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md — Financial Dashboard
> **A Standard for AI Agents**  
> *Clear instructions. Better agents. Real results.*

---

## 01 | Execution
**Take ownership and keep going.** *(Plan • Execute • Iterate • Deliver)*

* **Understand the Task:** Ingest the full request, understand the underlying objective, and identify any implicit requirements before writing code.
* **Define Definition of Done (DoD):** Explicitly establish the criteria for success before execution starts.
* **Autonomous Continuation:** Work autonomously without unnecessary human intervention or asking for permission on routine decisions.
* **Bias for Results:** Do not pause simply to announce progress or ask "Should I continue?"—keep driving forward until the DoD is reached.
* **Meaningful Updates:** Keep the user informed with concise, meaningful progress when transitioning between major phases.

---

## 02 | Human Approval
**Stop only when necessary.**

**Request approval ONLY when:**
1. A required architectural decision or missing external input strictly blocks further execution.
2. An operation could delete or irreversibly modify user data, tables, or production state.
3. A force push (`git push --force`), branch deletion, or other destructive Git operation is required.
4. Changes outside the assigned workspace repository boundaries are required.
5. Sensitive data, credentials, secrets, or production systems could be compromised.

> 🔒 **Rule of Thumb:** Otherwise, keep going and execute autonomously.

---

## 03 | Multi-Agent Collaboration
**Work together, achieve more.** *(Specialize • Collaborate • Integrate • Go Further)*

* **Deconstruct & Delegate:** Break down complex, multi-faceted problems and assign focused tasks to specialized subagents.
* **Clear Scopes & Roles:** Give each agent an unambiguous responsibility and bounded context.
* **Domain & File Partitioning (Recommendation):** Partition tasks by file path, subsystem, or layer (e.g. frontend routes vs backend API vs worker) to avoid concurrent file write conflicts, race conditions, or git merge collisions.
* **Validate Before Integrating:** Actively review and validate each subagent's output against the DoD before merging into the main thread.
* **Coherent Integration:** Synthesize outputs into a unified, cleanly integrated solution.
* **Shared Context:** Pass context forward systematically and capture lessons learned across agents.

---

## 04 | Task Tracking
**Use a shared TODO list as the source of truth.** *(Track • Organize • Prioritize • Complete)*

* **Maintain `TASKS.md`:** Maintain a living task list for visibility and session continuity.
* **Adaptive Tracking (Recommendation):**
  * *Multi-step / complex features:* Maintain a structured `TASKS.md` at the project root or in the working directory.
  * *Quick fixes / minor tasks:* Use inline progress reporting or local scratch tracking to avoid unnecessary repository file churn and git pollution.
* **Update Dynamically:** Mark tasks complete immediately after verifiable progress and append newly discovered edge cases or requirements.
* **Track Blockers:** Explicitly record any blockers, deferred items, or unresolved questions.

---

## 05 | Validation
**Verify before declaring completion.** *(Test • Verify • Trust)*

* **Verify Every DoD Criterion:** Inspect all deliverables against the agreed Definition of Done.
* **Execute Verification:** Run relevant test suites (unit tests, integration tests, E2E) and linters (`npm test`, `npm run lint`, `npm run build`).
* **Inspect the Final Diff:** Always review `git diff` or changed files to verify clean formatting, no leftover debug code, and no unintended edits.
* **Zero Hallucination Policy:** **Never claim a task is complete unless it was actually executed and verified.**
* **Surface Assumptions & Skipped Checks:** Explicitly document any unverified assumptions and declare any checks that could not be run (e.g. due to missing external APIs or credentials).

---

## 06 | Final Report
**End with a clear, concise summary.** *(Clear • Concise • Actionable)*

Every completed mission or session handoff must conclude using this standard 4-part structure:

1. **✅ Completed:** What was delivered and verified against the Definition of Done.
2. **📁 Changed:** List of modified/created files and key architectural updates.
3. **⚠️ Issues:** Known limitations, edge cases, blockers, or items requiring human review.
4. **💡 Next Steps:** Concrete recommended next actions or follow-ups.

---

## 07 | Technical Invariants & Guardrails (Project-Specific)

### Agent skills
* **Issue tracker:** Issues and specs live in GitHub Issues (`mandid9/Financial_Dashboard`). See `docs/agents/issue-tracker.md`.
* **Domain docs:** Single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.

### Hard rules (learned from production incidents — do not violate)

#### Secret & keypair generation must be atomic
Never split a keypair/secret across multiple shell invocations. Each run of a generator
(e.g. `npx web-push generate-vapid-keys`) produces **unrelated** values; capturing the
public key from one run and the private key from another yields a silently mismatched
pair that only fails at delivery time with opaque provider errors (e.g. FCM 403
`permission denied: invalid JWT provided`).

Correct pattern:
```bash
OUT=$(npx web-push generate-vapid-keys)
PUB=$(echo "$OUT" | grep -A1 "Public Key" | tail -1)
PRIV=$(echo "$OUT" | grep -A1 "Private Key" | tail -1)   # same $OUT, one generation
```
Then verify pairing before shipping: sign-and-verify locally, or confirm the public key
served by `/api/push/subscribe` matches the pair used by `src/lib/push.js`.

#### Other incident rules
- VAPID keys, `CRON_SECRET`, `WEBHOOK_SECRET` live in Vercel env vars only — never as code
  fallbacks in `src/lib/push.js` or route files.
- Push send failures are surfaced to the client (`errors`, `statusCode`, `body`), not
  swallowed; the UI test button authenticates via session cookie, cron paths via
  `Authorization: Bearer CRON_SECRET`.
- The service worker serves pages network-first (`public/sw.js`, cache v3+). Never revert
  HTML to stale-first caching; UI updates must reach devices on first reload.
- DB migrations: apply schema BEFORE deploying code that queries new columns. Safe path:
  `docs/migrate_v2_safe.sql`. Do not enable RLS until routes use per-request authenticated
  clients (anon client + RLS = invisible rows).
