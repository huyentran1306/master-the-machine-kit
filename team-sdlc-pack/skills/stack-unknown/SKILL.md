---
name: stack-unknown
description: Work on a customer system whose stack the kit has no specific notes for - find the real install, build and test commands, the code for an item, and produce evidence, without guessing. Read once when recon_repo reports unknownStack or no commands.
---

# Unfamiliar stack: find the truth, do not guess

The kit's rules (Start Work, answers/evidence, one submission, push before submit) never change with the stack. Only the commands do.

## 1. Commands (3 minutes, in this order)
1. Use the worker brief commands/appPath and baselinePath; during preparation use recon_repo.
2. The repository `README.md` / `CONTRIBUTING.md` / `docs/` and any `env-require/README.md`: the setup section is the contract.
3. Build files: `Makefile` / `Taskfile.yml` targets, `package.json` scripts, `pom.xml` profiles, `*.csproj`, `pyproject.toml` `[tool.*]`, `go.mod`, `composer.json`, `Gemfile`, `mix.exs`.
4. Test runner config (`vitest.config`, `jest.config`, `pytest.ini`, `phpunit.xml`, `*.Tests.csproj`, `src/test/java`) tells you where tests live and how to run one file.
Write the chosen commands into the worker brief directory's baseline.md (preparation: `<checkoutRoot>/.mtm-notes/baseline.md`): install, build, full test, single test, how long each takes, which tests already fail.

## 2. Keep the loop cheap
- Iterate with the single-test command; run the full suite once on the commit.
- No build command? Use the compiler/typechecker the stack has (`tsc --noEmit`, `mvn -q -B -DskipTests package`, `dotnet build`, `go build ./...`, `mypy`), or skip it and say so in the answer.
- A step that needs a service you cannot start (DB, broker, external API): use the narrowest check that runs, record that scenario as NOT_RUN with the reason, and ship. Never spend more than 3 minutes fighting the environment.

## 3. Find the code for an item
Search the user-visible strings first (`rg -n "<label or error code>"`), then the route/handler, then the service/repository layer, then the data model. Read only the ranges you need. For a regression, `git -C "<checkoutRoot>" log --oneline -15 -- "<folder>/"` plus `git -C "<checkoutRoot>" show --stat <sha> -- "<folder>/"` on recent customer commits.

## 4. Match the project's conventions
Copy the patterns already in the repo: error shape, validation layer, naming, logging, migrations (a schema change needs the project's own migration mechanism, committed with the code), i18n strings, and where config/version values live. Do not add a dependency, change the framework, or reformat files.

## 5. Evidence without a familiar runner
Every MVS scenario needs a reproducible proof: the exact command and its output lines, or an HTTP request/response pair, or a screenshot for UI. Put the command inside the evidence file so the grader can repeat it.
