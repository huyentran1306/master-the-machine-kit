# Conservative model-router experiment

This variant keeps the Player-selected root/orchestrator model unchanged and changes only worker models, so it can be compared directly with `Kit3-tran-v2-2.9.4-race`.

| Worker lane | Preferred model | Effort |
| --- | --- | --- |
| First-pass PI | `gpt-6.1-sol` | low; medium when less than four minutes remain |
| Answer-only TASK | `gpt-6.1-terra` | low; medium when less than four minutes remain |
| First-pass code | `gpt-6.1-terra` | medium |
| Retry, resumed, rolled-back or orphaned work | `gpt-6.1-sol` | high with at least ten minutes left; otherwise medium |

Luna is deliberately not a preferred scored-worker model after the all-Luna rehearsal scored 216/1000 and missed a TASK. The helper never invents authority to use another model: it selects the first preferred model present in lifecycle `allowedModels`. If neither Sol nor Terra is allowed, it uses the allowed orchestrator model, then the first allowed model; that last-resort fallback can still be Luna when the lifecycle policy offers no stronger model. If there is no model policy, `entry.model` is omitted and the worker inherits the orchestrator model exactly as in the control kit.

## A/B run

1. Install each kit into a different fresh team workspace.
2. Use the same Player version, match-authorized root model and comparable rematch inputs.
3. Control A: `Kit3-tran-v2-2.9.4-race`.
4. Router B: `Kit3-tran-v2-2.9.4-race-model-router`.
5. After each match record score, completed items, wall time, input/cached/output/reasoning tokens, model breakdown, wait-call count, retries and manual repairs.
6. Reject the router if PI loses correctness or either answer-only TASK regresses. Keep it only if quality holds and cost or completion time improves across representative matches.

Check the first `dispatch_ready` result before trusting the experiment: PI should show Sol, first-pass TASK/code should show Terra, and only retries should return to Sol. If the entries differ, inspect lifecycle `allowedModels`; the match policy may have forced a fallback.
