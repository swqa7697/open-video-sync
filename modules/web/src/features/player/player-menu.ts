export interface PlayerMenuItem {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  href?: string;
  disabled?: boolean;
  separator?: boolean;
}
