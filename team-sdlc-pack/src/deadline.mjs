// Bound waits for read-only operations. This does not cancel the operation: never use
// it to abandon a POST or a state mutation that could later create a submission.
export async function until(promise, deadlineAt) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Operation deadline exceeded'), { code: 'DEADLINE_EXCEEDED' })), Math.max(0, deadlineAt - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const SUBMIT_LIMITS = Object.freeze({ preflightMs: 20000, retryMs: 60000, refreshMs: 5000 });
