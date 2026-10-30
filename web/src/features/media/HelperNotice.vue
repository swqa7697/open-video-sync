<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { HelperBridge, HelperError, helperRelease } from '../../player/bilibili/bridge';
import Modal from '../../components/Modal.vue';
import Icon from '../../components/Icon.vue';
const emit = defineEmits<{ ready: [] }>();
type State = 'checking' | 'ready' | 'missing' | 'outdated' | 'mismatch' | 'communication' | 'stale';
const state = ref<State>('checking'),
  installed = ref(''),
  modal = ref(false);
const seen = new Set<string>();
const lifetime = new AbortController();
let bridge: HelperBridge | undefined;
const text = computed(
  () =>
    ({
      checking: 'Checking the OVS playback helper…',
      ready: '',
      missing: 'OVS playback helper not detected.',
      outdated: 'OVS playback helper needs an update.',
      mismatch: 'This helper does not match this OVS instance.',
      communication:
        'The playback helper could not be checked. Check network and script permissions.',
      stale: 'OVS has been updated. Refresh the application before updating the helper.',
    })[state.value],
);
const action = computed(() =>
  state.value === 'outdated'
    ? 'Update helper'
    : state.value === 'mismatch'
      ? 'Install matching helper'
      : 'Install OVS helper',
);
async function check(): Promise<void> {
  if (bridge) return;
  const previous = state.value;
  state.value = 'checking';
  bridge = new HelperBridge();
  try {
    const response = await fetch('/userscripts/ovs-bilibili.version.json', {
      cache: 'no-store',
      signal: lifetime.signal,
    });
    if (!response.ok) throw new Error('unavailable');
    const deployed: unknown = await response.json();
    if (
      !deployed ||
      typeof deployed !== 'object' ||
      !('version' in deployed) ||
      !('protocol' in deployed)
    )
      throw new Error('unavailable');
    if (
      deployed.version !== helperRelease.version ||
      deployed.protocol !== helperRelease.protocol
    ) {
      state.value = 'stale';
      return;
    }
    let reply;
    try {
      reply = await bridge.handshake(true);
    } catch (reason) {
      // Older releases have no non-owning probe and cannot run the current adapter.
      if (!(reason instanceof HelperError) || reason.code !== 'invalid-request') throw reason;
      reply = await bridge.handshake();
    }
    installed.value = reply.helper;
    if (reply.version !== helperRelease.protocol || reply.maxChunk !== 262144)
      state.value = 'mismatch';
    else if (reply.helper === helperRelease.version) state.value = 'ready';
    else {
      const a = reply.helper.split('.').map(Number),
        b = helperRelease.version.split('.').map(Number);
      const difference = a.findIndex((value, index) => value !== b[index]);
      state.value =
        /^\d+\.\d+\.\d+$/.test(reply.helper) && difference >= 0 && a[difference]! < b[difference]!
          ? 'outdated'
          : 'mismatch';
    }
  } catch (reason) {
    if (lifetime.signal.aborted) return;
    state.value =
      reason instanceof HelperError && reason.code === 'helper-missing'
        ? 'missing'
        : 'communication';
  } finally {
    bridge?.close(2, false);
    bridge = undefined;
    if (!lifetime.signal.aborted) {
      if (state.value === 'ready') {
        modal.value = false;
        if (previous !== 'ready') emit('ready');
      } else if (['missing', 'outdated', 'mismatch'].includes(state.value)) {
        const key = `${state.value}:${installed.value}`;
        if (!seen.has(key)) {
          seen.add(key);
          modal.value = true;
        }
      }
    }
  }
}
function refresh(): void {
  location.reload();
}
function focusCheck(): void {
  void check();
}
onMounted(() => {
  void check();
  window.addEventListener('focus', focusCheck);
});
onUnmounted(() => {
  lifetime.abort();
  bridge?.close(2, false);
  window.removeEventListener('focus', focusCheck);
});
defineExpose({ check });
</script>
<template>
  <aside v-if="state !== 'ready'" class="helper-banner" aria-label="Playback helper">
    <Icon name="screen" /><span>{{ text }}</span>
    <template v-if="state !== 'checking'">
      <button v-if="state === 'stale'" class="quiet" @click="refresh">Refresh application</button>
      <a
        v-else-if="state !== 'communication'"
        class="helper-link"
        href="/userscripts/ovs-bilibili.user.js"
        target="_blank"
        rel="noopener noreferrer"
        >{{ action }}</a
      >
      <button class="quiet" @click="check">Recheck</button>
    </template>
  </aside>
  <Modal v-if="modal" title="Set up Bilibili playback" @close="modal = false">
    <div class="setup-symbol"><Icon name="screen" :size="32" /></div>
    <h3>{{ text }}</h3>
    <p>
      Install the Tampermonkey browser extension independently. Then install and enable the OVS
      helper from this instance.
    </p>
    <p v-if="installed" class="version-note">
      Installed {{ installed }} · Required {{ helperRelease.version }}
    </p>
    <p class="hint">
      Confirm replacement when updating an existing helper. Return here and refresh OVS if needed.
      Local files work without the helper.
    </p>
    <div class="actions">
      <a
        class="button"
        href="/userscripts/ovs-bilibili.user.js"
        target="_blank"
        rel="noopener noreferrer"
        >{{ action }}<Icon name="arrow" /></a
      ><button class="quiet" @click="check">Recheck</button
      ><button class="quiet" @click="modal = false">Later</button>
    </div>
  </Modal>
</template>
