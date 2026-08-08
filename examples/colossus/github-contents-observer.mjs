import {
  GitHubContentsProviderError,
  GitHubContentsProviderObserver as BaseGitHubContentsProviderObserver
} from './github-contents-provider-v2.mjs';

const DEFAULT_ATTEMPTS = 20;
const DEFAULT_DELAY_MS = 250;

/**
 * Read-only convergence wrapper for GitHub Contents observations.
 *
 * It may repeat GET observations while waiting for an already-authorized
 * desired fingerprint to become visible. It never performs, retries, or
 * delegates a mutation. If convergence is not observed within the bounded
 * attempt budget, the latest real observation is returned for fail-closed
 * classification by the recovery coordinator.
 */
export class GitHubContentsProviderObserver {
  #observer;
  #attempts;
  #delayMs;

  constructor({
    consistencyAttempts = DEFAULT_ATTEMPTS,
    consistencyDelayMs = DEFAULT_DELAY_MS,
    ...providerOptions
  } = {}) {
    if (!Number.isSafeInteger(consistencyAttempts) || consistencyAttempts <= 0) {
      throw new GitHubContentsProviderError(
        'consistencyAttempts must be a positive safe integer',
        'GITHUB_CONTENTS_CONSISTENCY_CONFIG_INVALID'
      );
    }
    if (!Number.isSafeInteger(consistencyDelayMs) || consistencyDelayMs < 0) {
      throw new GitHubContentsProviderError(
        'consistencyDelayMs must be a non-negative safe integer',
        'GITHUB_CONTENTS_CONSISTENCY_CONFIG_INVALID'
      );
    }
    this.#observer = new BaseGitHubContentsProviderObserver(providerOptions);
    this.#attempts = consistencyAttempts;
    this.#delayMs = consistencyDelayMs;
  }

  async inspectOutcome({ uncertainty, signal } = {}) {
    const expectedFingerprint = uncertainty?.desiredFingerprint;
    return await this.#converge({
      expectedFingerprint,
      signal,
      observe: () => this.#observer.inspectOutcome({ uncertainty, signal })
    });
  }

  async inspectTarget({ target, expectedFingerprint = null, signal } = {}) {
    return await this.#converge({
      expectedFingerprint,
      signal,
      observe: () => this.#observer.inspectTarget({ target, signal })
    });
  }

  async #converge({ expectedFingerprint, signal, observe }) {
    if (expectedFingerprint != null && !/^sha256:[0-9a-f]{64}$/.test(expectedFingerprint)) {
      throw new GitHubContentsProviderError(
        'expectedFingerprint must be a sha256 fingerprint',
        'GITHUB_CONTENTS_EXPECTED_FINGERPRINT_INVALID'
      );
    }

    let latest = null;
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      assertNotAborted(signal);
      latest = await observe();
      if (expectedFingerprint == null ||
          (latest.exists && latest.contentFingerprint === expectedFingerprint)) {
        return latest;
      }
      if (attempt < this.#attempts) {
        await delay(this.#delayMs, signal);
      }
    }
    return latest;
  }
}

function delay(ms, signal) {
  if (ms === 0) {
    assertNotAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GitHubContentsProviderError(
        'GitHub Contents observation was aborted',
        'GITHUB_CONTENTS_OBSERVATION_ABORTED'
      ));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    Promise.resolve().then(() => timer).finally(cleanup);
  });
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw new GitHubContentsProviderError(
      'GitHub Contents observation was aborted',
      'GITHUB_CONTENTS_OBSERVATION_ABORTED'
    );
  }
}
