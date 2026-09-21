<script setup lang="ts">
import type { SelectContentEmits, SelectContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import {
  SelectContent,
  SelectPortal,
  SelectViewport,
  useForwardPropsEmits,
} from 'reka-ui'
import { cn } from '@/lib/utils'
import { SelectScrollDownButton, SelectScrollUpButton } from '.'

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<SelectContentProps & { class?: HTMLAttributes['class'] }>(),
  {
    position: 'item-aligned',
    align: 'center',
  },
)
const emits = defineEmits<SelectContentEmits>()

const delegatedProps = reactiveOmit(props, 'class')

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SelectPortal>
    <SelectContent
      data-slot="select-content"
      :data-align-trigger="position === 'item-aligned'"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn(
        'bg-popover text-foreground opacity-100 min-w-36 rounded-lg border border-border p-1 shadow-xl relative z-50 max-h-(--reka-select-content-available-height) origin-(--reka-select-content-transform-origin) overflow-x-hidden overflow-y-auto',
        position === 'popper'
          && 'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
        props.class,
      )
      "
    >
      <SelectScrollUpButton />
      <SelectViewport
        :data-position="position"
        :class="cn(
          'w-full min-w-(--reka-select-trigger-width) p-0.5',
        )"
      >
        <slot />
      </SelectViewport>
      <SelectScrollDownButton />
    </SelectContent>
  </SelectPortal>
</template>
