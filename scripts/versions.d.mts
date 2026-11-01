export function readVersions(): { sync: string; web: string; helper: string };
export function readBuildInfo(root?: string): {
  commit: string;
  dirty: boolean;
  tag: string;
};
