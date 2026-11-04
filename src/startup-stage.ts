import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Records the startup step the bridge is inside, in its own state folder.
 *
 * Startup touches folders that other apps own, and one of them can block inside an
 * OS permission prompt or on a disk that has gone to sleep. When that happens the
 * bridge stops answering with no error to show, and the owner is left guessing
 * whether the app is broken or busy. A frozen process cannot report anything
 * afterwards either, so the step is written *before* the work starts: the last step
 * on disk is the one that never finished, and the app says so.
 */
export function recordStage(stateDir: string, stage: string) {
  try {
    writeFileSync(
      join(stateDir, 'startup-stage.json'),
      JSON.stringify({ stage, at: Date.now() }),
      { mode: 0o600 },
    );
  } catch {
    /* A missing stage file only costs a clearer message. */
  }
}

/** Cleared once startup is past the steps that can block. */
export function clearStage(stateDir: string) {
  try {
    unlinkSync(join(stateDir, 'startup-stage.json'));
  } catch {
    /* Already gone, or never written. */
  }
}