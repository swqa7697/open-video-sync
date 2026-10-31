import { parseSelection } from '../../player/bilibili/media';

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
  query: string
): CommandMatch[] {
  const raw = query.trim();
  if (raw.startsWith('$') || /^(?:https?:\/\/|BV)/i.test(raw)) {
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
          .includes(word)
      )
    )
    .sort(
      (a, b) =>
        Number(b.shortcut === `/${words.join(' ')}`) -
        Number(a.shortcut === `/${words.join(' ')}`)
    )
    .map((command) => ({ command }));
}
