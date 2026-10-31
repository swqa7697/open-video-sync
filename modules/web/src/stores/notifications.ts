import { defineStore } from 'pinia';
import { ref } from 'vue';

export const notificationPositions = ['left', 'center', 'right'] as const;
type Position = (typeof notificationPositions)[number];
export const useNotificationStore = defineStore('notifications', () => {
  let initial: Position = 'right';
  try {
    const saved = localStorage.getItem('ovs.notifications');
    initial = notificationPositions.find((value) => value === saved) ?? initial;
  } catch {
    /* Keep the default when storage is blocked. */
  }
  const position = ref(initial);
  const saved = ref(true);
  function setPosition(value: Position): void {
    position.value = value;
    try {
      localStorage.setItem('ovs.notifications', value);
      saved.value = true;
    } catch {
      saved.value = false;
    }
  }
  return { position, saved, setPosition };
});
