# Training scenario 02

A 40-minute, 1,000-point rehearsal with ten items across nine release windows:

- Wave 0: `TASK-11`, `BUG-11`
- Minute 5: `CR-11` with an 18-minute deadline
- Minute 9: `TASK-12`
- Minute 12: `PI-11`, ranked against simulated rivals at 5, 9 and 14 minutes
- Minute 15: `TASK-13`
- Minute 18: `BUG-13` with a 10-minute deadline
- Minute 20: `BUG-12` with a 12-minute deadline
- Minute 24: `CR-12` with a 12-minute deadline
- Minute 30: `TASK-14`

TASK and PI have no MVS. CR and BUG receive MVS only after Start working and require evidence. Every item has hidden scenarios outside its published acceptance examples.

Run from `dpt-kit`:

```powershell
npm run rehearsal:training:setup
npm run mock:training
```

Use `mock/scenarios/training-02/START_PROMPT.md` as the Game Player prompt. Start the clock from another terminal:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:4020/admin/start
```

For a faster rehearsal run `npm run mock:training -- --time-scale 4`. Do not expose the `hidden/` directory to the contestant agent.
