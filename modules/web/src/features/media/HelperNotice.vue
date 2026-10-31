<script setup lang="ts">
import { t } from '../../i18n';

import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  HelperBridge,
  HelperError,
  helperRelease,
} from '../../player/bilibili/bridge';
import Modal from '../../components/Modal.vue';
import Icon from '../../components/Icon.vue';
import ToastNotice from '../../components/ToastNotice.vue';
const emit = defineEmits<{ ready: [] }>();
type State =
  | 'checking'
  | 'ready'
  | 'missing'
  | 'outdated'
  | 'mismatch'
  | 'communication'
  | 'stale';
const state = ref<State>('checking'),
  installed = ref(''),
  modal = ref(false),
  toastVisible = ref(true);
const seen = new Set<string>();
const lifetime = new AbortController();
let bridge: HelperBridge | undefined;
const text = computed(
  () =>
    ({
      checking: t('helper.checking'),
      ready: '',
      missing: t('helper.missing'),
      outdated: t('helper.outdated'),
      mismatch: t('helper.mismatch'),
      communication: t('helper.communication'),
      stale: t('helper.stale'),
    })[state.value]
);
const action = computed(() =>
  state.value === 'outdated'
    ? t('helper.update')
    : state.value === 'mismatch'
      ? t('helper.installMatching')
      : t('helper.install')
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
      deployed.protocol !== helperRelease.protocol ||
      !('build' in deployed) ||
      deployed.build !== helperRelease.build
    ) {
      state.value = 'stale';
      return;
    }
    let reply;
    try {
      reply = await bridge.handshake(true);
    } catch (reason) {
      // Older releases have no non-owning probe and cannot run the current adapter.
      if (!(reason instanceof HelperError) || reason.code !== 'invalid-request')
        throw reason;
      reply = await bridge.handshake();
    }
    installed.value = reply.helper;
    if (reply.version !== helperRelease.protocol || reply.maxChunk !== 262144)
      state.value = 'mismatch';
    else if (reply.helper === helperRelease.version)
      state.value = reply.build === helperRelease.build ? 'ready' : 'outdated';
    else {
      const a = reply.helper.split('.').map(Number),
        b = helperRelease.version.split('.').map(Number);
      const difference = a.findIndex((value, index) => value !== b[index]);
      state.value =
        /^\d+\.\d+\.\d+$/.test(reply.helper) &&
        difference >= 0 &&
        a[difference]! < b[difference]!
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
  <ToastNotice
    v-if="state !== 'ready' && toastVisible"
    @dismiss="toastVisible = false"
    ><aside class="helper-banner" :aria-label="t('helper.label')">
      <Icon name="screen" /><span>{{ text }}</span>
      <template v-if="state !== 'checking'">
        <button v-if="state === 'stale'" class="quiet" @click="refresh">
          {{ t('helper.refresh') }}
        </button>
        <a
          v-else-if="state !== 'communication'"
          class="helper-link"
          href="/userscripts/ovs-bilibili.user.js"
          target="_blank"
          rel="noopener noreferrer"
          >{{ action }}</a
        >
        <button v-if="state !== 'stale'" class="quiet" @click="refresh">
          {{ t('common.reload') }}
        </button>
      </template>
    </aside></ToastNotice
  >
  <Modal v-if="modal" :title="t('helper.setup')" @close="modal = false">
    <div class="setup-symbol"><Icon name="screen" :size="32" /></div>
    <h3>{{ text }}</h3>
    <p>{{ t('helper.instructions') }}</p>
    <p v-if="installed" class="version-note">
      {{ t('helper.version', { installed, required: helperRelease.version }) }}
    </p>
    <p class="hint">{{ t('helper.installHint') }}</p>
    <div class="actions">
      <a
        class="button"
        href="/userscripts/ovs-bilibili.user.js"
        target="_blank"
        rel="noopener noreferrer"
        >{{ action }}<Icon name="arrow" /></a
      ><button class="quiet" @click="refresh">{{ t('common.reload') }}</button
      ><button class="quiet" @click="modal = false">
        {{ t('helper.later') }}
      </button>
    </div>
  </Modal>
</template>
