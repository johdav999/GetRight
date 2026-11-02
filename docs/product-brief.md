# Product brief

## Purpose

Getright makes user acceptance testing reproducible across WriterApp and Virtual
Company. A functional workflow can still be confusing. The product records
automated verification and a user's judgment as independent results.

## Intended cycle

1. Choose an application and a readable, executable test.
2. Run it in a visible browser with isolated accounts and test data.
3. Review the tested version, steps, screenshots, trace and errors.
4. Attach a comment and desired outcome to a specific step.
5. Review an implementation task assembled from that evidence.
6. Explicitly start a Codex job in an isolated Git worktree.
7. Build and launch the changed application, identify the build actually running,
   rerun the original test and compare evidence.
8. Make a new human acceptance decision for the new run.

The current starter supports steps 1–5 for its isolated demo. Steps 6–8 require the
job and application lifecycle work described in the roadmap.

## First applications

WriterApp starts with five draft workflows: create/save/reopen a document,
generate a synopsis, edit/reopen, share/accept, and save-failure recovery. Its
existing `Tests/sharing-workspace.mjs` is a starting reference, not an adapter that
Getright currently executes. It uses isolated API fixtures with the actual client.
Preserve that distinction when importing it; fixture UI checks are not live
multi-user acceptance evidence.

Virtual Company's first business workflow remains to be selected. Its adapter
needs explicit company data, roles, identity setup, steps and expected results.

## Run and feedback requirements

- Stable test/step identifiers and a copy of the definition at run creation.
- A unique run and fixture ID, timestamps and execution status.
- The identity of the application build actually running, not just repository HEAD.
- Environment identity and step-linked evidence, including failures where possible.
- Feedback retaining the original wording and requested outcome.
- A generated task with reproduction context and acceptance criteria.
- No inherited acceptance from a previous run or from automated success.

## Later capabilities

Editable job prompts, streamed Codex progress, worktree lifecycle management,
build/launch logs, previous/new evidence comparison, more application adapters and
eventually central hosting with authenticated workers. None is required to run
the local demo foundation.
