# Model-router experiment

This variant keeps the Player-selected root/orchestrator model unchanged and changes only worker models, so it can be compared directly with `Kit3-tran-v2-2.9.4-race`.

| Worker lane | Preferred model | Effort |
| --- | --- | --- |
| Answer-only TASK/PI | `gpt-6-luna` | low; medium when less than four minutes remain |
| First-pass code | `gpt-6.1-terra` | medium |
| Retry, resumed, rolled-back or orphaned work | `gpt-6.1-sol` | high with at least ten minutes left; otherwise medium |

The helper never invents authority to use these models. It selects the first preferred model present in lifecycle `allowedModels`. If none is allowed, it uses the allowed orchestrator model, then the first allowed model. If there is no model policy, `entry.model` is omitted and the worker inherits the orchestrator model exactly as in the control kit.

## A/B run

1. Install each kit into a different fresh team workspace.
2. Use the same Player version, match-authorized root model and comparable rematch inputs.
3. Control A: `Kit3-tran-v2-2.9.4-race`.
4. Router B: `Kit3-tran-v2-2.9.4-race-model-router`.
5. After each match record score, completed items, wall time, input/cached/output/reasoning tokens, model breakdown, wait-call count, retries and manual repairs.
6. Keep the router only if score does not fall and cost or completion time improves across representative matches.

Check the first `dispatch_ready` result before trusting the experiment: its spawn entries must show the actual authorized `model`. If every entry falls back to the same root model, that match's `allowedModels` did not permit a meaningful routing comparison.
