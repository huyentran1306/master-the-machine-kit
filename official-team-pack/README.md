# Official mtm-player team pack — integration scaffold

This directory is the **official-match boundary** introduced after the 23 Oct technical briefing. It is separate from `mock/`: no script here starts a clock, calls a mock Admin route, accesses unreleased backlog items, or pretends that an undocumented API is verified.

## What the briefing establishes

The screenshots supplied by the team establish this sequence:

1. `mtm-player` launches/monitors the Team Orchestrator.
2. The orchestrator completes match login and an environment check, then reports `ENVIRONMENT_READY` with request id, repository, revision, build result and match-login result.
3. The player acknowledges preparation; the orchestrator sends `PREPARED` and waits for the official `IN_PROGRESS` status.
4. After login, it reads the assigned match, synchronizes every visible backlog item as `DISCOVERED`, then may Start Work for an item.
5. Start Work is an official operation. The briefing shows `POST /api/v1/matches/<UUID>/backlogs/start` with `{ "backlogItemKey": "TASK-01" }`; it returns source template/scenarios. Do not code an item before the official Start Work receipt.

The briefing does **not** provide the complete login, match-read, submit, receipt, registration, agent-TOML or `progress.ndjson` schemas. Those fields intentionally remain templates until BTC provides its example pack or CLI contract.

## Pack layout

```
official-team-pack/
  team-pack.json                 local manifest of the intended capabilities
  agents/*.toml                  role declarations: orchestrator + four specialists
  progress.ndjson.example        required event vocabulary and shape
  progress-log.mjs               append-only local writer/validator for rehearsal
  team-orchestrator.mjs          phase helper; never calls undocumented APIs
  mtm-player.config.template.json configuration mapping to fill only from BTC docs
```

## Safe preparation workflow

```powershell
Set-Location ..\official-team-pack
node team-orchestrator.mjs environment-ready --request-id '<from-mtm-player>' --repository '<assigned-repository>' --revision '<checked-out-sha>' --build PASS --match-login PASS
node team-orchestrator.mjs prepared
```

The helper writes `progress.ndjson` in this directory. It is deliberately local-only. The official submission/callback transport must be supplied by the BTC player contract; wire it only after its payload and acknowledgement semantics are known.

## Agent roles

The four specialist TOML files mirror the reference structure shown in the briefing. They are a role declaration, **not permission to run parallel writers**. The coordinator remains the only process that changes Git state or performs Start Work / submit. During a live match, workers must remain read-only unless BTC explicitly permits a different model.

## Required confirmation from BTC

- How are agent TOML registrations discovered and validated?
- Is `progress.ndjson` watched at a fixed path, passed as an argument, or uploaded? What is its exact JSON schema?
- Which command/API performs MATCH_LOGIN, read match, preparation acknowledgement and submit?
- What exact status and receipt fields prove Start Work and submit were accepted?
- Does the listed Start Work endpoint require bearer token scopes/origins beyond the supplied team token?

