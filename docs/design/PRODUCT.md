# Assay — Product

## What it is

A desktop hub for running testing and ethical-pentest tools over your own projects —
local folders and published URLs — then fixing what they find with AI, all in one place.

Point it at a project, run a tool, get findings, hit **Fix with AI**, **Retest** to verify.
Every run is snapshotted for a full audit trail.

## Who it's for

Developers auditing code they own. Single user, local machine, no accounts, no server.
The user is technical: they read logs, recognise CLI commands, and expect to see the exact
command before it runs.

## Scope guardrail

For your own projects only. URL scans are gated behind an explicit authorization
confirmation. Nothing is committed or pushed without an explicit action.

## Core objects

| Object | Meaning |
|---|---|
| **Project** | A local folder and/or a URL, with a detected stack |
| **Tool** | A scanner run against a project (react-doctor, unlighthouse, strix, SonarQube) |
| **Run** | One execution: command, streamed log, status, duration — immutable once finished |
| **Finding** | A normalized issue from a run: severity, file, line, message, rule, remediation |
| **Edit** | A per-file diff produced by an AI fix run |
| **Skill / Command** | Reusable AI tasks and project actions, run agentically |

## The loop the product exists for

    scan → findings → fix with AI → retest → findings drop to solved

Everything in the interface serves that loop. A screen that doesn't move the user along it
is in the way.

## Principles

1. **Show the command.** Never run anything the user hasn't seen written out first.
2. **Never lie about an outcome.** A run's status comes from what was recorded, not from
   an assumption. Failures say what failed and where to look.
3. **The working tree is sacred.** Tools write reports outside the project; only an
   explicit AI fix edits source, and every edit is captured as a diff.
4. **Long work stays visible.** Scans take minutes. The user must be able to leave a run
   going, do something else, and come back to it.
5. **Dense, not cramped.** This is a devtool: information per screen matters more than
   whitespace, but never at the cost of legibility.

## Non-goals

- Team features, sharing, cloud sync, accounts.
- Being a CI system — this is interactive, local, one machine.
- Hiding the tools behind abstractions: the CLIs and their output stay visible.
