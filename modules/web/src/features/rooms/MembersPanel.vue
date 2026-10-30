<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { Snapshot } from '../../transport/api';
import { memberState } from '../status-text';
const props = defineProps<{ room: Snapshot; host: boolean; busy: boolean }>();
const emit = defineEmits<{ remove: [id: string] }>();
const heading = ref<HTMLElement>();
let removing = '';
watch(
  () => props.room.members.map((m) => m.memberId).join(),
  async () => {
    if (removing && !props.room.members.some((m) => m.memberId === removing)) {
      removing = '';
      await nextTick();
      heading.value?.focus();
    }
  }
);
</script>
<template>
  <div class="members-content">
    <div class="members-heading">
      <h3 id="participants-title" ref="heading" tabindex="-1">Participants</h3>
      <span class="count">{{ room.members.length }}</span>
    </div>
    <ul class="roster" aria-labelledby="participants-title">
      <li v-for="member in room.members" :key="member.memberId">
        <span
          class="avatar"
          :class="{ 'host-avatar': member.role === 'host' }"
          >{{ member.displayName.slice(0, 1).toUpperCase() }}</span
        >
        <div class="member-info">
          <strong
            >{{
              member.memberId === room.selfMemberId
                ? 'You'
                : member.displayName
            }}<span v-if="member.role === 'host'" class="host-label"
              >Host</span
            ></strong
          ><span
            v-if="member.memberId === room.selfMemberId"
            class="self-name"
            >{{ member.displayName }}</span
          ><small
            ><span
              class="status-dot"
              :class="{ offline: member.presence !== 'connected' }"
            />{{ memberState(member, room.mediaGeneration) }}</small
          >
        </div>
        <button
          v-if="host && member.role !== 'host'"
          class="quiet remove-member"
          :disabled="busy"
          :aria-label="`Remove ${member.displayName}`"
          @click="
            removing = member.memberId;
            emit('remove', member.memberId);
          "
        >
          Remove
        </button>
      </li>
    </ul>
    <p class="members-footnote">Everyone watches from their own device.</p>
  </div>
</template>
