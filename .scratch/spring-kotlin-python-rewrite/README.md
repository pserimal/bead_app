# Local Wayfinder tracker

This directory is the local Markdown issue tracker for the Spring Boot + Kotlin / Python CRNN rewrite.

## Layout

- `000-map.md` — the canonical Wayfinder map.
- `issues/*.md` — child decision tickets.

## Front matter

Each issue has:

- `id`: local issue identity;
- `title`: issue name; refer to issues by this title in conversation;
- `labels`: `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`;
- `state`: `open` or `closed`;
- `parent`: `000` for children of the map;
- `blocked_by`: local issue ids of open blockers;
- `assignee`: claim holder, or `null` when unclaimed.

## Operations

- Claim: set `assignee` before doing work.
- Resolve: append a `## Resolution` section, set `state: closed`, and clear it from the frontier.
- Block: add blocker ids to `blocked_by` in a second pass after all issue files exist.
- Frontier: child issues with `state: open`, an empty `blocked_by`, and `assignee: null`.

Open tickets are discovered from issue front matter rather than duplicated in the map body. The map only indexes closed decisions under `Decisions so far` and records the remaining fog under `Not yet specified`.
