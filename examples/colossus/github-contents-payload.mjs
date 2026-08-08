import { deepFreeze } from '../../src/dispatch/common.mjs';
import { githubContentFingerprint } from './github-contents-reference.mjs';

/**
 * Builds the public payload shape consumed by GitHubContentsColossusTransport.
 * The transport performs the authoritative validation again before I/O.
 */
export function githubContentsPayload({ target, desiredContent, baseline, commitMessage }) {
  return deepFreeze({
    provider: { stableId: 'github-contents/v1' },
    operation: 'put',
    target: { ...target },
    desired: {
      encoding: 'utf-8',
      content: desiredContent,
      fingerprint: githubContentFingerprint(desiredContent)
    },
    baseline: { ...baseline },
    commitMessage
  });
}
