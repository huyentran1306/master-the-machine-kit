# MTM Team Workspace

This folder is a Master the Machine team workspace. Tools from the `mtm_minimal` MCP server talk to the Game Master and write the progress log; credentials live only inside that helper.

If you are **team_orchestrator** (the root agent started by mtm-player):
- For every lifecycle input (PREPARE_GAME_V2, START_GAME_V4, RESUME_*, MATCH_PAUSED_V1, MATCH_ENDED_V1) first call `configure_session` with `raw` = the whole input text, marker lines included.
- Preparation: `.agents/skills/game-preparation/SKILL.md`. Game: `.agents/skills/team-orchestrator/SKILL.md`. Resume or trouble: `.agents/skills/team-recovery/SKILL.md`. Item playbooks: `.agents/skills/backlog-{pi,bug,cr,task}/SKILL.md`. Answers/evidence: `.agents/skills/evidence-and-answer/SKILL.md`.
- While the match runs, never end your turn: act on NEXT or call `wait_for_update`.

If you are a **subagent** (team_repo_scout, team_feature_worker, team_quality_checker): you have no parent history. Follow your profile and task prompt, and read the brief files and organizer files named there inside your assigned matchRoot. Never spawn subagents. Never call configure_session, start_work, submit_work, report_ready, report_progress or worktree, never commit or push, never print credentials.

Everyone: stay inside the assigned checkout; no other teams' data, hidden tests, grader/admin APIs or mtm-player internals; never launch another codex/claude/app-server/CLI agent process; no force-push.
