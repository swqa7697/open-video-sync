import { computed } from 'vue';
import { t } from '../../i18n';
import {
  appearanceAccents,
  appearanceModes,
  useAppearanceStore,
} from '../../stores/appearance';
import { languageOptions, useLanguageStore } from '../../stores/language';
import type { QuickCommand } from './search';

export function usePreferenceCommands(
  open: (panel: 'appearance' | 'language' | 'notifications' | 'about') => void
) {
  const appearance = useAppearanceStore(),
    language = useLanguageStore();
  return computed<QuickCommand[]>(() => [
    ...(
      [
        {
          panel: 'appearance',
          icon: 'appearance',
          label: 'common.appearance',
          aliases: 'appearance preferences 外观 设置',
        },
        {
          panel: 'language',
          icon: 'language',
          label: 'common.language',
          aliases: 'language locale 语言 设置',
        },
        {
          panel: 'notifications',
          icon: 'bell',
          label: 'common.notifications',
          aliases: 'notifications toast position 通知 提示 位置',
        },
        {
          panel: 'about',
          icon: 'info',
          label: 'common.about',
          aliases: 'about version 关于 版本',
        },
      ] as const
    ).map(({ panel, icon, label, aliases }) => ({
      id: panel,
      label: t(label),
      group: 'app' as const,
      icon,
      aliases,
      shortcut: `/${panel}`,
      run: () => open(panel),
    })),
    ...appearanceModes.map((mode) => ({
      id: `theme:${mode.value}`,
      group: 'app' as const,
      icon: mode.icon,
      label: `${t('appearance.mode')} · ${t(mode.label)}`,
      shortcut: `/theme ${mode.value}`,
      aliases: `appearance color mode 主题 外观 ${mode.value === 'dark' ? '深色 暗色' : '浅色 亮色'}`,
      run: () => {
        appearance.setMode(mode.value);
        if (!appearance.saved) open('appearance');
      },
    })),
    ...appearanceAccents.map((accent) => ({
      id: `accent:${accent.value}`,
      group: 'app' as const,
      icon: 'appearance',
      label: `${t('appearance.accent')} · ${t(accent.label)}`,
      shortcut: `/accent ${accent.value}`,
      aliases: 'color colour accent 颜色 强调色',
      run: () => {
        appearance.setAccent(accent.value);
        if (!appearance.saved) open('appearance');
      },
    })),
    ...languageOptions.map((value) => ({
      id: `language:${value}`,
      group: 'app' as const,
      icon: 'language',
      label: `${t('common.language')} · ${value === 'system' ? t('language.system') : value === 'en' ? 'English' : '简体中文'}`,
      shortcut: `/language ${value}`,
      aliases: `language locale 语言 ${value === 'en' ? '英文 英语 english' : value === 'zh-CN' ? '中文 chinese zh' : '跟随系统 automatic'}`,
      run: () => {
        language.setLanguage(value);
        if (!language.saved) open('language');
      },
    })),
  ]);
}
