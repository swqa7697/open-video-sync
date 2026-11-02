export function readVersions(): { sync: string; web: string; helper: string };
export function readImageTag(root?: string): string;
export function readBuildInfo(root?: string): {
  image: string;
  release: boolean;
  commit: string;
  dirty: boolean;
  tag: string;
};
