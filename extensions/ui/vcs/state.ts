export interface PullRequestInfo {
  number: number;
  url: string;
  isDraft: boolean;
}

export interface VcsInfoState {
  isRepository: boolean;
  kind: "git" | "jj" | null;
  label: string | null;
  changedFiles: number;
  pullRequest: PullRequestInfo | null;
}

export function emptyVcsInfoState(): VcsInfoState {
  return {
    isRepository: false,
    kind: null,
    label: null,
    changedFiles: 0,
    pullRequest: null,
  };
}
