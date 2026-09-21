<script setup lang="ts">
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import {
  addSum,
  crc16Ccitt,
  crc16Modbus,
  crc32,
  crc8,
  formatChecksum,
  lrc,
  parsePayload,
  xorSum,
} from "@/lib/checksum";
import {
  base64ToBytes,
  bytesToBase64,
  decodeUrl,
  encodeUrl,
  formatByBase,
  parseByBase,
} from "@/lib/convert";
import { md5, sha1, sha256 } from "@/lib/hash";
import { bytesToHex, bytesToText, hexToBytes, textToBytes } from "@/lib/hex";
import { formatDateTime } from "@/lib/format";
import { insertToComposer } from "@/lib/composer-insert";
import AppSelect from "@/components/common/AppSelect.vue";
import RadixBytes from "@/components/common/RadixBytes.vue";
import RadixToggle from "@/components/common/RadixToggle.vue";
import BitCalc from "@/components/tools/BitCalc.vue";
import FloatOrder from "@/components/tools/FloatOrder.vue";
import RegexLab from "@/components/tools/RegexLab.vue";
import ToolFold from "@/components/tools/ToolFold.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Radix } from "@/lib/radix";

const checkInput = ref("01 03 00 00 00 01");
const checkHex = ref(true);
const checkAlgo = ref("crc16-modbus");
const checkResult = ref("");

const numInput = ref("255");
const numBase = ref<2 | 8 | 10 | 16>(10);
const numOut = computed(() => {
  const value = parseByBase(numInput.value, numBase.value);
  if (value == null) return null;
  return {
    bin: formatByBase(value, 2),
    oct: formatByBase(value, 8),
    dec: formatByBase(value, 10),
    hex: formatByBase(value, 16),
  };
});

const codecInput = ref("");
const codecKind = ref<"base64" | "url" | "hex">("hex");
const codecResult = ref("");

const tsInput = ref(String(Date.now()));
const tsKind = ref<"ms" | "s" | "iso">("ms");
const tsOut = computed(() => {
  const raw = tsInput.value.trim();
  let ms = Date.now();
  try {
    if (tsKind.value === "iso") ms = new Date(raw).getTime();
    else if (tsKind.value === "s") ms = Number(raw) * 1000;
    else ms = Number(raw);
  } catch {
    return t("err.badTime");
  }
  if (!Number.isFinite(ms)) return t("err.badTime");
  return `${formatDateTime(ms)}\nUnix ms ${ms}\nUnix s ${Math.floor(ms / 1000)}\nISO ${new Date(ms).toISOString()}`;
});

const hashInput = ref("");
const hashHex = ref(false);
const hashOut = ref("");

const checkAlgoOptions = computed(() => [
  { value: "crc16-modbus", label: "CRC16-Modbus" },
  { value: "crc16-ccitt", label: "CRC16-CCITT" },
  { value: "crc32", label: "CRC32" },
  { value: "crc8", label: "CRC8" },
  { value: "lrc", label: "LRC" },
  { value: "xor", label: "XOR" },
  { value: "sum", label: t("tools.sum") },
]);
const codecKindOptions = computed(() => [
  { value: "hex", label: t("tools.hexText") },
  { value: "base64", label: "Base64" },
  { value: "url", label: "URL" },
]);
const tsKindOptions = computed(() => [
  { value: "ms", label: t("tools.ms") },
  { value: "s", label: t("tools.sec") },
  { value: "iso", label: "ISO" },
]);
const hexTxtOptions = computed(() => [
  { value: "hex", label: "HEX" },
  { value: "txt", label: "TXT" },
]);
const numBaseOptions = computed(() => [
  { value: 2, label: "BIN" },
  { value: 8, label: "OCT" },
  { value: 10, label: "DEC" },
  { value: 16, label: "HEX" },
]);
const hashHexOptions = computed(() => [
  { value: "txt", label: "TXT" },
  { value: "hex", label: "HEX" },
]);

const numRadix = computed<Radix>(() => (numBase.value === 16 ? "HEX" : "DEC"));

const openFold = ref("checksum");

function toggleNumRadix() {
  const value = parseByBase(numInput.value, numBase.value);
  const next: 10 | 16 = numBase.value === 16 ? 10 : 16;
  numBase.value = next;
  if (value != null) numInput.value = formatByBase(value, next);
}

function insert(content: string, mode: "hex" | "ascii" = "hex") {
  if (!content.trim()) return;
  insertToComposer(content.trim(), mode);
}

function runChecksum() {
  try {
    const bytes = parsePayload(checkInput.value, checkHex.value);
    if (!bytes.length) throw new Error(t("err.inputEmpty"));
    const map: Record<string, { name: string; value: number; width: number }> = {
      "crc16-modbus": { name: "CRC16-Modbus", value: crc16Modbus(bytes), width: 2 },
      "crc16-ccitt": { name: "CRC16-CCITT", value: crc16Ccitt(bytes), width: 2 },
      crc32: { name: "CRC32", value: crc32(bytes), width: 4 },
      crc8: { name: "CRC8", value: crc8(bytes), width: 1 },
      lrc: { name: "LRC", value: lrc(bytes), width: 1 },
      xor: { name: "XOR", value: xorSum(bytes), width: 1 },
      sum: { name: "SUM", value: addSum(bytes), width: 1 },
    };
    const item = map[checkAlgo.value];
    checkResult.value = formatChecksum(item.name, item.value, item.width);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("err.checksumFail"));
  }
}

function runCodec(direction: "encode" | "decode") {
  try {
    if (codecKind.value === "hex") {
      codecResult.value =
        direction === "encode"
          ? bytesToHex(textToBytes(codecInput.value))
          : bytesToText(hexToBytes(codecInput.value));
      return;
    }
    if (codecKind.value === "url") {
      codecResult.value =
        direction === "encode" ? encodeUrl(codecInput.value) : decodeUrl(codecInput.value);
      return;
    }
    codecResult.value =
      direction === "encode"
        ? bytesToBase64(textToBytes(codecInput.value))
        : bytesToText(base64ToBytes(codecInput.value));
  } catch {
    toast.error(t("err.convertFail"));
  }
}

async function runHash() {
  try {
    const bytes = hashHex.value ? hexToBytes(hashInput.value) : textToBytes(hashInput.value);
    if (!bytes.length) throw new Error(t("err.inputEmpty"));
    const [m, s1, s256] = await Promise.all([
      Promise.resolve(md5(bytes)),
      sha1(bytes),
      sha256(bytes),
    ]);
    hashOut.value = `MD5    ${m}\nSHA1   ${s1}\nSHA256 ${s256}`;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("err.hashFail"));
  }
}
</script>

<template>
  <div class="space-y-2 text-xs">
    <ToolFold
      :title="t('composer.checksum')"
      :model-value="openFold === 'checksum' ? t('composer.checksum') : ''"
      @update:model-value="openFold = $event ? 'checksum' : ''"
    >
      <RadixBytes v-if="checkHex" v-model="checkInput" />
      <Textarea v-else v-model="checkInput" class="min-h-16 font-mono text-[12px]" />
      <div class="flex flex-wrap gap-1">
        <AppSelect
          :model-value="checkAlgo"
          :options="checkAlgoOptions"
          class="w-[140px]"
          @update:model-value="checkAlgo = String($event)"
        />
        <AppSelect
          :model-value="checkHex ? 'hex' : 'txt'"
          :options="hexTxtOptions"
          class="w-[72px]"
          @update:model-value="checkHex = $event === 'hex'"
        />
        <Button size="sm" @click="runChecksum">{{ t("tools.calc") }}</Button>
        <Button size="sm" variant="outline" :disabled="!checkResult" @click="insert(checkResult, 'ascii')">{{ t("common.insert") }}</Button>
      </div>
      <div v-if="checkResult" class="font-mono text-[11px]">{{ checkResult }}</div>
    </ToolFold>

    <ToolFold
      :title="t('tools.radix')"
      :model-value="openFold === 'radix' ? t('tools.radix') : ''"
      @update:model-value="openFold = $event ? 'radix' : ''"
    >
      <div class="flex gap-1">
        <div class="relative min-w-0 flex-1">
          <Input v-model="numInput" class="h-7 pr-8 font-mono text-xs" />
          <RadixToggle
            v-if="numBase === 10 || numBase === 16"
            class="absolute top-1/2 right-1.5 z-10 -translate-y-1/2"
            :radix="numRadix"
            @click="toggleNumRadix"
          />
        </div>
        <AppSelect
          :model-value="numBase"
          :options="numBaseOptions"
          class="w-[84px]"
          @update:model-value="numBase = Number($event) as 2 | 8 | 10 | 16"
        />
      </div>
      <div v-if="numOut" class="space-y-0.5 font-mono text-[11px]">
        <div>BIN {{ numOut.bin }}</div>
        <div>OCT {{ numOut.oct }}</div>
        <div>DEC {{ numOut.dec }}</div>
        <div>HEX {{ numOut.hex }}</div>
      </div>
      <Button
        v-if="numOut"
        size="sm"
        variant="outline"
        @click="insert(numOut.hex, 'hex')"
      >
        {{ t("tools.insertHex") }}
      </Button>
    </ToolFold>

    <ToolFold
      :title="t('tools.ieee')"
      :model-value="openFold === 'ieee' ? t('tools.ieee') : ''"
      @update:model-value="openFold = $event ? 'ieee' : ''"
    >
      <FloatOrder />
    </ToolFold>

    <ToolFold
      :title="t('tools.bits')"
      :model-value="openFold === 'bits' ? t('tools.bits') : ''"
      @update:model-value="openFold = $event ? 'bits' : ''"
    >
      <BitCalc />
    </ToolFold>

    <ToolFold
      :title="t('tools.codec')"
      :model-value="openFold === 'codec' ? t('tools.codec') : ''"
      @update:model-value="openFold = $event ? 'codec' : ''"
    >
      <Textarea v-model="codecInput" class="min-h-14 font-mono text-[12px]" :placeholder="t('tools.codecPh')" />
      <div class="flex flex-wrap gap-1">
        <AppSelect
          :model-value="codecKind"
          :options="codecKindOptions"
          class="w-[120px]"
          @update:model-value="codecKind = $event as typeof codecKind"
        />
        <Button size="sm" @click="runCodec('encode')">{{ t("tools.encode") }}</Button>
        <Button size="sm" variant="outline" @click="runCodec('decode')">{{ t("tools.decode") }}</Button>
        <Button size="sm" variant="outline" :disabled="!codecResult" @click="insert(codecResult, codecKind === 'hex' ? 'hex' : 'ascii')">{{ t("common.insert") }}</Button>
      </div>
      <div v-if="codecResult" class="break-all font-mono text-[11px]">{{ codecResult }}</div>
    </ToolFold>

    <ToolFold
      :title="t('tools.regexLab')"
      :model-value="openFold === 'regex' ? t('tools.regexLab') : ''"
      @update:model-value="openFold = $event ? 'regex' : ''"
    >
      <RegexLab />
    </ToolFold>

    <ToolFold
      :title="t('dash.time')"
      :model-value="openFold === 'time' ? t('dash.time') : ''"
      @update:model-value="openFold = $event ? 'time' : ''"
    >
      <div class="flex gap-1">
        <Input v-model="tsInput" class="h-7 font-mono text-xs" />
        <AppSelect
          :model-value="tsKind"
          :options="tsKindOptions"
          class="w-[80px]"
          @update:model-value="tsKind = $event as typeof tsKind"
        />
        <Button size="sm" variant="outline" @click="tsInput = String(Date.now()); tsKind = 'ms'">{{ t("tools.now") }}</Button>
      </div>
      <pre class="font-mono text-[11px] whitespace-pre-wrap">{{ tsOut }}</pre>
      <Button size="sm" variant="outline" @click="insert(tsOut, 'ascii')">{{ t("common.insert") }}</Button>
    </ToolFold>

    <ToolFold
      :title="t('tools.hash')"
      :model-value="openFold === 'hash' ? t('tools.hash') : ''"
      @update:model-value="openFold = $event ? 'hash' : ''"
    >
      <RadixBytes v-if="hashHex" v-model="hashInput" />
      <Textarea v-else v-model="hashInput" class="min-h-14 font-mono text-[12px]" />
      <div class="flex flex-wrap gap-1">
        <AppSelect
          :model-value="hashHex ? 'hex' : 'txt'"
          :options="hashHexOptions"
          class="w-[72px]"
          @update:model-value="hashHex = $event === 'hex'"
        />
        <Button size="sm" @click="runHash">{{ t("tools.calc") }}</Button>
        <Button size="sm" variant="outline" :disabled="!hashOut" @click="insert(hashOut, 'ascii')">{{ t("common.insert") }}</Button>
      </div>
      <pre v-if="hashOut" class="font-mono text-[11px] whitespace-pre-wrap">{{ hashOut }}</pre>
    </ToolFold>

  </div>
</template>
