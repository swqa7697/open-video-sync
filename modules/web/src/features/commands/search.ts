import {
  parseSelection,
  type Episode,
  type Playlist,
} from '../../player/bilibili/media';

export interface EpisodeActions {
  playlist: Playlist | undefined;
  current: Episode | undefined;
  canSelect: boolean;
  note: string;
  unavailable: string;
  selection:
    | {
        episode: Episode;
        phase: 'loading' | 'pending' | 'accepted' | 'failed';
        error: string;
      }
    | undefined;
  select(episode: Episode): void;
}
export interface EpisodeMatch {
  episode: Episode;
  number: number;
}
export function searchEpisodes(
  playlist: Playlist,
  query: string,
): EpisodeMatch[] {
  const raw = query.trim().slice(1).trim().toLocaleLowerCase();
  const entries = playlist.episodes.map((episode, index) => ({
    episode,
    number: index + 1,
  }));
  if (/^[0-9]+$/.test(raw))
    return entries.filter((entry) => entry.number === Number(raw));
  const words = raw.split(/\s+/);
  return entries.filter(({ episode }) =>
    words.every((word) => episode.title.toLocaleLowerCase().includes(word)),
  );
}

export type VideoSelection = ReturnType<typeof parseSelection>;
export interface QuickCommand {
  id: string;
  label: string;
  group: 'watch' | 'room' | 'app';
  icon: string;
  shortcut: string;
  aliases: string;
  detail?: string | undefined;
  disabled?: boolean;
  run: (selection?: VideoSelection) => void;
}
export interface CommandMatch {
  command: QuickCommand;
  selection?: VideoSelection;
}

// Search stays in this page. Video arguments use the same allowlist as the picker.
export function searchCommands(
  commands: QuickCommand[],
  query: string,
): CommandMatch[] {
  const raw = query.trim();
  if (raw.startsWith('$') || /^(?:https?:\/\/|BV|ss[0-9]|ep[0-9])/i.test(raw)) {
    const input = raw.startsWith('$') ? raw.slice(1).trim() : raw;
    const command = commands.find((item) => item.id === 'video');
    if (!command) return [];
    return input
      ? [{ command, selection: parseSelection(input, 1) }]
      : [{ command }];
  }
  const words = raw.replace(/^\//, '').toLocaleLowerCase().split(/\s+/);
  return commands
    .filter((command) =>
      words.every((word) =>
        `${command.label} ${command.shortcut} ${command.aliases}`
          .toLocaleLowerCase()
          .includes(word),
      ),
    )
    .sort(
      (a, b) =>
        Number(b.shortcut === `/${words.join(' ')}`) -
        Number(a.shortcut === `/${words.join(' ')}`),
    )
    .map((command) => ({ command }));
}
