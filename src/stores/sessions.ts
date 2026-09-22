import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import { toast } from "vue-sonner";
import { t } from "@/i18n";
import { bytesToHex, bytesToText, hexToBytes, textToBytes } from "@/lib/hex";
import {
  invokeConnect,
  invokeDisconnect,
  invokeKick,
  invokeListPorts,
  invokeMqttSub,
  invokeMqttUnsub,
  invokeSend,
  isTauri,
  errorMessage,
} from "@/lib/ipc";
import { defaultConfig, nextSessionName, normalizeAiConfig, normalizeDbConfig, normalizeFtpConfig, normalizeSshConfig, PROTOCOL_META, RAIL_PROTOCOLS, randomClientId } from "@/lib/protocol";
import { insertToComposer, pendingComposerInsert } from "@/lib/composer-insert";
import { isMqttWildcard, mqttTopicColor, mqttTopicMatches } from "@/lib/mqtt";
import { useUiStore } from "@/stores/ui";
import { useAiStore, type AiChatMessage } from "@/stores/ai";
import type {
  DataMode,
  LogMessage,
  MqttSubscription,
  MqttTopicEntry,
  ProtocolType,
  SendHistoryItem,
  SerialPortInfo,
  Session,
  SessionConfig,
  SshConfig,
  TcpClientInfo,
} from "@/types";

type ComposerState = { draft: string; mode: DataMode };

export type SessionSnapshot = {
  id: string;
  name: string;
  protocol: ProtocolType;
  createdAt: number;
  config: SessionConfig;
  mqttSubs?: MqttSubscription[];
  mqttMuted?: Record<string, boolean>;
  topicFilter?: string;
  displayMode?: DataMode;
  composer?: ComposerState;
  aiMessages?: AiChatMessage[];
};

function defaultMode(protocol: ProtocolType): DataMode {
  return protocol === "mqtt" || protocol === "websocket" ? "ascii" : "hex";
}

const HISTORY_CAP = 200;

interface RxFramePayload {
  timestamp: number;
  data: number[];
  source?: string | null;
  color?: string | null;
  topic?: string | null;
}

interface RxBatchPayload {
  sessionId: string;
  frames: RxFramePayload[];
}

interface StatusPayload {
  sessionId: string;
  status: string;
  error?: string | null;
}

interface PortsPayload {
  ports: SerialPortInfo[];
  added: string[];
  removed: string[];
}

interface ClientsPayload {
  sessionId: string;
  clients: TcpClientInfo[];
}

function asBytes(data: unknown): number[] {
  if (!Array.isArray(data)) return [];
  return data.map((b) => Number(b) & 0xff);
}

function restoreConfig(protocol: ProtocolType, config: SessionConfig): SessionConfig {
  if (protocol === "ssh") return normalizeSshConfig(config as SshConfig);
  if (protocol === "ftp") return normalizeFtpConfig(config.kind === "ftp" ? config : undefined);
  if (protocol === "db") return normalizeDbConfig(config.kind === "db" ? config : undefined);
  if (protocol === "ai") return normalizeAiConfig(config.kind === "ai" ? config : undefined);
  const merged = { ...defaultConfig(protocol), ...config } as SessionConfig;
  if (merged.kind === "mqtt") {
    const id = merged.clientId.trim();
    merged.clientId = !id || /^commbox_/i.test(id) ? "" : id;
  }
  return merged;
}

function connectConfig(config: SessionConfig): SessionConfig {
  if (config.kind === "serial") {
    return { ...config, baudRate: Number(config.baudRate) || 115200 };
  }
  if (config.kind === "tcp") {
    return { ...config, port: Number(config.port) || 0 };
  }
  if (config.kind === "udp") {
    return {
      ...config,
      localPort: Number(config.localPort) || 0,
      remotePort: Number(config.remotePort) || 0,
    };
  }
  if (config.kind === "mqtt") {
    return {
      ...config,
      port: Number(config.port) || 0,
      keepAlive: Number(config.keepAlive) || 60,
      clientId: config.clientId.trim() || randomClientId(),
    };
  }
  if (config.kind === "ssh") {
    return normalizeSshConfig(config);
  }
  if (config.kind === "ftp") {
    return normalizeFtpConfig(config);
  }
  if (config.kind === "db") {
    return normalizeDbConfig(config);
  }
  return config;
}

export const useSessionsStore = defineStore("sessions", () => {
  const sessions = ref<Session[]>([]);
  const activeId = ref<string | null>(null);
  const messages = reactive<Record<string, LogMessage[]>>({});
  const displayMode = reactive<Record<string, DataMode>>({});
  const autoScroll = reactive<Record<string, boolean>>({});
  const history = ref<SendHistoryItem[]>([]);
  const serialPorts = ref<SerialPortInfo[]>([]);
  const tcpClients = reactive<Record<string, TcpClientInfo[]>>({});
  const tcpTarget = reactive<Record<string, string>>({});
  const mqttSubs = reactive<Record<string, MqttSubscription[]>>({});
  const mqttMuted = reactive<Record<string, Record<string, boolean>>>({});
  const topicFilter = reactive<Record<string, string>>({});
  const sending = reactive<Record<string, boolean>>({});
  const selectedIds = reactive<Record<string, string[]>>({});
  const lastClickedId = reactive<Record<string, string>>({});
  const composer = reactive<Record<string, ComposerState>>({});

  const ui = useUiStore();
  let unlisteners: Array<() => void> = [];
  let bound = false;

  const activeSession = computed(
    () => sessions.value.find((s) => s.id === activeId.value) ?? null,
  );

  const filteredSessions = computed(() => {
    const allowed = RAIL_PROTOCOLS[ui.rail];
    if (!allowed) return sessions.value;
    return sessions.value.filter((s) => allowed.includes(s.protocol));
  });

  const recentSessions = computed(() =>
    [...sessions.value]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, 6),
  );

  const activeMessages = computed(
    () => (activeId.value ? messages[activeId.value] ?? [] : []),
  );

  const visibleMessages = computed(() => {
    const id = activeId.value;
    if (!id) return [];
    const list = messages[id] ?? [];
    const session = sessions.value.find((s) => s.id === id);
    if (!session || session.protocol !== "mqtt") return list;
    const filter = topicFilter[id] ?? "";
    if (filter) {
      return list.filter((m) => mqttTopicMatches(filter, m.topic ?? ""));
    }
    return list.filter((m) => !m.topic || !isMqttTopicPaused(id, m.topic));
  });

  function initSessionState(session: Session, extra?: Partial<SessionSnapshot>) {
    messages[session.id] = [];
    displayMode[session.id] = extra?.displayMode ?? defaultMode(session.protocol);
    autoScroll[session.id] = true;
    tcpClients[session.id] = [];
    tcpTarget[session.id] = "all";
    mqttSubs[session.id] = (extra?.mqttSubs ?? [])
      .filter((s) => s?.topic?.trim())
      .map((s) => ({
        topic: s.topic.trim(),
        qos: s.qos === 1 || s.qos === 2 ? s.qos : 0,
        enabled: s.enabled !== false,
      }));
    mqttMuted[session.id] = { ...(extra?.mqttMuted ?? {}) };
    topicFilter[session.id] = extra?.topicFilter ?? "";
    composer[session.id] = {
      draft: extra?.composer?.draft ?? "",
      mode:
        extra?.composer?.mode === "ascii"
          ? "ascii"
          : extra?.composer?.mode === "hex"
            ? "hex"
            : defaultMode(session.protocol),
    };
    if (session.protocol === "ai") {
      useAiStore().hydrateSession(session.id, extra?.aiMessages ?? []);
    }
  }

  function composerOf(id: string): ComposerState {
    const session = sessions.value.find((s) => s.id === id);
    if (!composer[id]) {
      composer[id] = { draft: "", mode: defaultMode(session?.protocol ?? "serial") };
    }
    return composer[id];
  }

  function createSession(protocol: ProtocolType, select = true): Session {
    const session: Session = {
      id: crypto.randomUUID(),
      name: nextSessionName(protocol, sessions.value),
      protocol,
      status: "disconnected",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      rxBytes: 0,
      txBytes: 0,
      rxFrames: 0,
      txFrames: 0,
      config: defaultConfig(protocol),
    };
    if (session.config.kind === "serial" && !session.config.port && serialPorts.value[0]) {
      session.config.port = serialPorts.value[0].name;
    }
    if (session.config.kind === "ai") {
      const prev = [...sessions.value].reverse().find((s) => s.config.kind === "ai");
      const from = prev && prev.config.kind === "ai" ? prev.config : null;
      session.config = {
        kind: "ai",
        baseUrl: from?.baseUrl || ui.settings.aiBaseUrl || "http://127.0.0.1:11434/v1",
        apiKey: from?.apiKey || ui.settings.aiApiKey,
        model: from?.model || ui.settings.aiModel,
      };
    }
    sessions.value.push(session);
    initSessionState(session);
    if (session.protocol === "ai") {
      useAiStore().claimLegacy(session.id);
    }
    if (select) {
      selectSession(session.id);
    }
    return session;
  }

  function selectSession(id: string) {
    const session = sessions.value.find((s) => s.id === id);
    if (!session) return;
    activeId.value = id;
    session.lastActiveAt = Date.now();
    ui.setRail(PROTOCOL_META[session.protocol].rail);
  }

  function activateRail(rail: ReturnType<typeof useUiStore>["rail"]) {
    ui.setRail(rail);
    const allowed = RAIL_PROTOCOLS[rail];
    if (!allowed) return;
    const current = activeSession.value;
    if (current && allowed.includes(current.protocol)) return;
    const match = sessions.value
      .filter((s) => allowed.includes(s.protocol))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (match) {
      activeId.value = match.id;
      match.lastActiveAt = Date.now();
    } else {
      activeId.value = null;
    }
  }

  function uniqueImportedName(base: string, used: Set<string>): string {
    const seed = base.trim() || t("common.session");
    if (!used.has(seed)) return seed;
    let n = 2;
    let name = t("pack.importedCopy", { seed });
    while (used.has(name)) {
      name = t("pack.importedN", { seed, n });
      n += 1;
    }
    return name;
  }

  function importSessions(list: SessionSnapshot[]): number {
    if (!list?.length) return 0;
    const usedIds = new Set(sessions.value.map((s) => s.id));
    const usedNames = new Set(sessions.value.map((s) => s.name));
    let added = 0;
    for (const item of list) {
      if (!(item.protocol in PROTOCOL_META)) continue;
      let id = item.id;
      if (!id || usedIds.has(id)) id = crypto.randomUUID();
      usedIds.add(id);
      const name = uniqueImportedName(item.name, usedNames);
      usedNames.add(name);
      const session: Session = {
        id,
        name,
        protocol: item.protocol,
        status: "disconnected",
        createdAt: item.createdAt || Date.now(),
        lastActiveAt: Date.now(),
        rxBytes: 0,
        txBytes: 0,
        rxFrames: 0,
        txFrames: 0,
        config: restoreConfig(item.protocol, item.config),
      };
      sessions.value.push(session);
      initSessionState(session, { ...item, id, name });
      added += 1;
    }
    return added;
  }

  function mergeHistory(list: SendHistoryItem[]) {
    if (!list?.length) return;
    const seen = new Set(history.value.map((h) => `${h.mode}:${h.content}`));
    const extra: SendHistoryItem[] = [];
    for (const item of list) {
      if (!item?.content) continue;
      const key = `${item.mode}:${item.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push({
        id: item.id && !history.value.some((h) => h.id === item.id) ? item.id : crypto.randomUUID(),
        sessionId: item.sessionId || "",
        sessionName: item.sessionName || "",
        mode: item.mode === "ascii" ? "ascii" : "hex",
        content: item.content,
        timestamp: item.timestamp || Date.now(),
      });
    }
    history.value = [...extra, ...history.value].slice(0, HISTORY_CAP);
  }

  async function disconnectBackend(id: string) {
    if (!isTauri()) return;
    try {
      await invokeDisconnect(id);
    } catch {
      /* 会话可能已不存在 */
    }
  }

  async function closeSession(id: string) {
    const index = sessions.value.findIndex((s) => s.id === id);
    if (index < 0) return;
    const session = sessions.value[index];
    if (session && (session.status === "connected" || session.status === "connecting")) {
      if (session.protocol === "ssh") {
        const ssh = (await import("@/stores/ssh")).useSshStore();
        await ssh.disconnect(id, true);
        ssh.dropSession(id);
      } else if (session.protocol === "ftp") {
        const ftp = (await import("@/stores/ftp")).useFtpStore();
        await ftp.disconnect(id);
        ftp.dropSession(id);
      } else if (session.protocol === "db") {
        const db = (await import("@/stores/db")).useDbStore();
        await db.disconnect(id);
        db.dropSession(id);
      } else {
        await disconnectBackend(id);
      }
    }
    sessions.value.splice(index, 1);
    if (session?.protocol === "ssh") {
      void import("@/stores/ssh").then((m) => m.useSshStore().dropSession(id));
    }
    if (session?.protocol === "ftp") {
      void import("@/stores/ftp").then((m) => m.useFtpStore().dropSession(id));
    }
    if (session?.protocol === "db") {
      void import("@/stores/db").then((m) => m.useDbStore().dropSession(id));
    }
    if (session?.protocol === "ai") {
      useAiStore().drop(id);
    }
    delete messages[id];
    delete displayMode[id];
    delete autoScroll[id];
    delete tcpClients[id];
    delete tcpTarget[id];
    delete mqttSubs[id];
    delete mqttMuted[id];
    delete topicFilter[id];
    delete sending[id];
    delete composer[id];
    if (activeId.value === id) {
      const next = sessions.value[index] ?? sessions.value[index - 1] ?? null;
      if (next) selectSession(next.id);
      else activeId.value = null;
    }
  }

  function requestClose(id: string) {
    const session = sessions.value.find((s) => s.id === id);
    if (!session) return;
    if (session.status === "connected" || session.status === "connecting") {
      ui.pendingCloseId = id;
      return;
    }
    void closeSession(id);
  }

  function renameSession(id: string, name: string) {
    const session = sessions.value.find((s) => s.id === id);
    if (!session) return;
    const next = name.trim();
    if (!next) return;
    session.name = next;
  }

  function updateConfig<T extends SessionConfig>(id: string, patch: Partial<T>) {
    const session = sessions.value.find((s) => s.id === id);
    if (!session) return;
    session.config = { ...session.config, ...patch } as SessionConfig;
  }

  function applyStatus(id: string, status: Session["status"], error?: string | null) {
    const session = sessions.value.find((s) => s.id === id);
    if (!session) return;
    session.status = status;
    session.lastActiveAt = Date.now();
    if (status !== "connected") {
      tcpClients[id] = [];
    }
    if (status === "connected") {
      void restoreMqttSubs(id);
    } else if (status === "error") {
      toast.error(error ? errorMessage(error) : t("err.sessionError", { name: session.name }));
    }
  }

  async function toggleConnect(id: string) {
    const session = sessions.value.find((s) => s.id === id);
    if (!session) return;
    if (session.protocol === "http") {
      toast.error(t("err.sendInHttp"));
      return;
    }
    if (session.protocol === "ai") {
      return;
    }
    if (session.protocol === "ssh") {
      const ssh = (await import("@/stores/ssh")).useSshStore();
      if (session.status === "connected" || session.status === "connecting") {
        await ssh.disconnect(id, true);
        return;
      }
      await ssh.connect(id);
      return;
    }
    if (session.protocol === "ftp") {
      const ftp = (await import("@/stores/ftp")).useFtpStore();
      if (session.status === "connected" || session.status === "connecting") {
        await ftp.disconnect(id);
        return;
      }
      await ftp.connect(id);
      return;
    }
    if (session.protocol === "db") {
      const db = (await import("@/stores/db")).useDbStore();
      if (session.status === "connected" || session.status === "connecting") {
        await db.disconnect(id);
        return;
      }
      await db.connect(id);
      return;
    }
    if (session.status === "connected" || session.status === "connecting") {
      if (isTauri()) {
        session.status = "disconnected";
        tcpClients[id] = [];
        await disconnectBackend(id);
        return;
      }
      session.status = "disconnected";
      return;
    }

    if (session.config.kind === "serial" && !session.config.port.trim()) {
      toast.error(t("err.noPort"));
      return;
    }
    if (session.config.kind === "tcp" && session.config.mode === "client" && !session.config.host.trim()) {
      toast.error(t("err.missing_host"));
      return;
    }
    if (session.config.kind === "websocket" && !session.config.url.trim()) {
      toast.error(t("err.missing_url"));
      return;
    }
    if (session.config.kind === "mqtt" && !session.config.broker.trim()) {
      toast.error(t("err.missing_broker"));
      return;
    }

    session.status = "connecting";
    if (!isTauri()) {
      window.setTimeout(() => {
        const current = sessions.value.find((s) => s.id === id);
        if (!current || current.status !== "connecting") return;
        current.status = "connected";
      }, 280);
      return;
    }

    try {
      await invokeConnect(id, connectConfig(session.config));
    } catch (err) {
      session.status = "error";
      toast.error(errorMessage(err));
    }
  }

  function pushMessage(
    sessionId: string,
    direction: LogMessage["direction"],
    bytes: number[],
    extra?: Partial<Pick<LogMessage, "timestamp" | "sourceLabel" | "color" | "topic">>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const list = messages[sessionId] ?? (messages[sessionId] = []);
    list.push({
      id: crypto.randomUUID(),
      sessionId,
      direction,
      timestamp: extra?.timestamp ?? Date.now(),
      hex: bytesToHex(bytes),
      ascii: bytesToText(bytes),
      byteLength: bytes.length,
      sourceLabel: extra?.sourceLabel,
      color: extra?.color ?? (extra?.topic ? mqttTopicColor(extra.topic) : undefined),
      topic: extra?.topic,
    });
    if (list.length > ui.settings.logLimit) {
      list.splice(0, list.length - ui.settings.logLimit);
    }
    if (direction === "tx") {
      session.txBytes += bytes.length;
      session.txFrames += 1;
    } else if (direction === "rx") {
      session.rxBytes += bytes.length;
      session.rxFrames += 1;
    }
    session.lastActiveAt = Date.now();
  }

  function rememberHistory(session: Session, content: string, mode: DataMode) {
    const last = history.value[0];
    if (!last || last.content !== content || last.mode !== mode) {
      history.value.unshift({
        id: crypto.randomUUID(),
        sessionId: session.id,
        sessionName: session.name,
        mode,
        content,
        timestamp: Date.now(),
      });
      if (history.value.length > HISTORY_CAP) {
        history.value.length = HISTORY_CAP;
      }
    }
  }

  async function sendToSession(
    id: string,
    content: string,
    mode: DataMode,
    extra?: { mqttTopic?: string; mqttQos?: number; skipHistory?: boolean },
  ) {
    const session = sessions.value.find((s) => s.id === id);
    if (!session) return false;
    if (session.protocol === "http") {
      toast.error(t("err.sendInHttp"));
      return false;
    }
    if (session.protocol === "ai") {
      return false;
    }
    if (session.protocol === "ssh" || session.protocol === "ftp" || session.protocol === "db") {
      return false;
    }
    if (session.status !== "connected") {
      toast.error(t("err.notConnected"));
      return false;
    }
    const bytes = mode === "hex" ? hexToBytes(content) : textToBytes(content);
    if (bytes.length === 0) return false;

    if (!isTauri()) {
      pushMessage(id, "tx", bytes, extra?.mqttTopic ? { topic: extra.mqttTopic } : undefined);
      if (!extra?.skipHistory) rememberHistory(session, content, mode);
      window.setTimeout(() => {
        pushMessage(id, "rx", bytes, {
          sourceLabel: "echo",
          topic: extra?.mqttTopic,
        });
      }, 60);
      return true;
    }

    sending[id] = true;
    try {
      await invokeSend(id, bytes, {
        mqttTopic: extra?.mqttTopic,
        mqttQos: extra?.mqttQos,
        tcpClientId:
          tcpTarget[id] && tcpTarget[id] !== "all" ? tcpTarget[id] : undefined,
        wsText: session.protocol === "websocket" ? mode === "ascii" : undefined,
      });
      pushMessage(id, "tx", bytes, extra?.mqttTopic ? { topic: extra.mqttTopic } : undefined);
      if (!extra?.skipHistory) rememberHistory(session, content, mode);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      sending[id] = false;
    }
  }

  function resend(message: LogMessage) {
    if (!activeId.value) {
      toast.error(t("err.noActive"));
      return;
    }
    void sendToSession(activeId.value, message.hex, "hex", {
      mqttTopic: message.topic,
    });
  }

  function resendHistory(item: SendHistoryItem) {
    if (!activeId.value) {
      toast.error(t("err.noActive"));
      return;
    }
    void sendToSession(activeId.value, item.content, item.mode);
  }

  function clearMessages(id: string) {
    messages[id] = [];
    selectedIds[id] = [];
  }

  const selectedCount = computed(() => {
    const id = activeId.value;
    if (!id) return 0;
    return (selectedIds[id] ?? []).length;
  });

  function isSelected(sessionId: string, messageId: string) {
    return (selectedIds[sessionId] ?? []).includes(messageId);
  }

  function clearSelection(sessionId?: string) {
    const id = sessionId ?? activeId.value;
    if (!id) return;
    selectedIds[id] = [];
  }

  function selectedRx(sessionId?: string): LogMessage[] {
    const id = sessionId ?? activeId.value;
    if (!id) return [];
    const ids = new Set(selectedIds[id] ?? []);
    return (messages[id] ?? []).filter((m) => m.direction === "rx" && ids.has(m.id));
  }

  function selectMessage(sessionId: string, messageId: string, range: boolean) {
    const list = (messages[sessionId] ?? []).filter((m) => m.direction === "rx");
    const ids = selectedIds[sessionId] ?? (selectedIds[sessionId] = []);
    if (range && lastClickedId[sessionId]) {
      const a = list.findIndex((m) => m.id === lastClickedId[sessionId]);
      const b = list.findIndex((m) => m.id === messageId);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        selectedIds[sessionId] = [...new Set([...ids, ...list.slice(from, to + 1).map((m) => m.id)])];
        lastClickedId[sessionId] = messageId;
        return;
      }
    }
    const at = ids.indexOf(messageId);
    if (at >= 0) ids.splice(at, 1);
    else ids.push(messageId);
    lastClickedId[sessionId] = messageId;
  }

  function selectAfterLastTx(sessionId: string) {
    const list = messages[sessionId] ?? [];
    let lastTx = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].direction === "tx") {
        lastTx = i;
        break;
      }
    }
    const rx = list.slice(lastTx + 1).filter((m) => m.direction === "rx");
    selectedIds[sessionId] = rx.map((m) => m.id);
    if (rx.length) lastClickedId[sessionId] = rx[rx.length - 1].id;
  }

  function resetCounters(id: string) {
    const session = sessions.value.find((s) => s.id === id);
    if (!session) return;
    session.rxBytes = 0;
    session.txBytes = 0;
    session.rxFrames = 0;
    session.txFrames = 0;
  }

  function switchNext() {
    const list = filteredSessions.value.length
      ? filteredSessions.value
      : sessions.value;
    if (list.length === 0) return;
    const index = list.findIndex((s) => s.id === activeId.value);
    const next = list[(index + 1) % list.length];
    if (next) selectSession(next.id);
  }

  function setDisplayMode(id: string, mode: DataMode) {
    displayMode[id] = mode;
  }

  function setAutoScroll(id: string, value: boolean) {
    autoScroll[id] = value;
  }

  function setTcpTarget(id: string, clientId: string) {
    tcpTarget[id] = clientId;
  }

  async function kickClient(sessionId: string, clientId: string) {
    if (!isTauri()) {
      tcpClients[sessionId] = (tcpClients[sessionId] ?? []).filter((c) => c.id !== clientId);
      return;
    }
    try {
      await invokeKick(sessionId, clientId);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function restoreMqttSubs(sessionId: string) {
    if (!isTauri()) return;
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session || session.protocol !== "mqtt" || session.status !== "connected") return;
    for (const sub of mqttSubs[sessionId] ?? []) {
      if (!sub.enabled) continue;
      try {
        await invokeMqttSub(sessionId, sub.topic, sub.qos);
      } catch (err) {
        toast.error(t("err.subFailed", { topic: sub.topic, detail: errorMessage(err) }));
      }
    }
  }

  async function subscribeMqtt(sessionId: string, topic: string, qos: 0 | 1 | 2) {
    const topicName = topic.trim();
    if (!topicName) {
      toast.error(t("err.missing_topic"));
      return;
    }
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const list = mqttSubs[sessionId] ?? (mqttSubs[sessionId] = []);
    const existing = list.find((s) => s.topic === topicName);
    if (existing) {
      existing.qos = qos;
      existing.enabled = true;
    } else list.push({ topic: topicName, qos, enabled: true });
    if (session.status !== "connected") {
      toast.message(t("err.noted", { t: topicName }));
      return;
    }
    if (!isTauri()) return;
    try {
      await invokeMqttSub(sessionId, topicName, qos);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function replaceMqttSub(
    sessionId: string,
    from: string,
    topic: string,
    qos: 0 | 1 | 2,
  ) {
    const next = topic.trim();
    const prev = from.trim();
    if (!next) {
      toast.error(t("err.missing_topic"));
      return;
    }
    const keepFilter = topicFilter[sessionId] === prev;
    if (prev && prev !== next) await unsubscribeMqtt(sessionId, prev);
    await subscribeMqtt(sessionId, next, qos);
    if (keepFilter) topicFilter[sessionId] = next;
  }

  async function unsubscribeMqtt(sessionId: string, topic: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    mqttSubs[sessionId] = (mqttSubs[sessionId] ?? []).filter((s) => s.topic !== topic);
    if (topicFilter[sessionId] === topic) topicFilter[sessionId] = "";
    if (!isTauri() || session?.status !== "connected") return;
    try {
      await invokeMqttUnsub(sessionId, topic);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function isMqttTopicPaused(sessionId: string, topic: string): boolean {
    if (mqttMuted[sessionId]?.[topic]) return true;
    const matching = (mqttSubs[sessionId] ?? []).filter((s) =>
      mqttTopicMatches(s.topic, topic),
    );
    return matching.length > 0 && matching.every((s) => !s.enabled);
  }

  function setTopicFilter(sessionId: string, topic: string) {
    topicFilter[sessionId] = topic;
  }

  function mqttTopicEntries(sessionId: string): MqttTopicEntry[] {
    const counts = new Map<string, number>();
    for (const message of messages[sessionId] ?? []) {
      if (!message.topic) continue;
      counts.set(message.topic, (counts.get(message.topic) ?? 0) + 1);
    }
    const entries: MqttTopicEntry[] = [];
    const seen = new Set<string>();
    for (const sub of mqttSubs[sessionId] ?? []) {
      seen.add(sub.topic);
      let count = 0;
      if (isMqttWildcard(sub.topic)) {
        for (const [topic, n] of counts) {
          if (mqttTopicMatches(sub.topic, topic)) count += n;
        }
      } else {
        count = counts.get(sub.topic) ?? 0;
      }
      entries.push({
        topic: sub.topic,
        count,
        enabled: sub.enabled,
        isSub: true,
        qos: sub.qos,
        color: mqttTopicColor(sub.topic),
      });
    }
    for (const [topic, count] of counts) {
      if (seen.has(topic)) continue;
      entries.push({
        topic,
        count,
        enabled: !mqttMuted[sessionId]?.[topic],
        isSub: false,
        color: mqttTopicColor(topic),
      });
    }
    return entries;
  }

  async function toggleMqttTopic(sessionId: string, topic: string) {
    const sub = (mqttSubs[sessionId] ?? []).find((item) => item.topic === topic);
    if (sub) {
      const next = !sub.enabled;
      const session = sessions.value.find((s) => s.id === sessionId);
      if (session?.status === "connected") {
        try {
          if (next) {
            if (isTauri()) await invokeMqttSub(sessionId, topic, sub.qos);
          } else if (isTauri()) {
            await invokeMqttUnsub(sessionId, topic);
          }
        } catch (err) {
          toast.error(errorMessage(err));
          return;
        }
      }
      sub.enabled = next;
      if (next && mqttMuted[sessionId]) mqttMuted[sessionId][topic] = false;
      toast.message(next ? t("err.topicOn", { topic }) : t("err.topicOff", { topic }));
      return;
    }
    const muted = mqttMuted[sessionId] ?? (mqttMuted[sessionId] = {});
    muted[topic] = !muted[topic];
    toast.message(muted[topic] ? t("err.topicOff", { topic }) : t("err.topicOn", { topic }));
  }

  async function bindBackend() {
    if (bound) return;
    bound = true;
    if (!isTauri()) return;
    const { listen } = await import("@tauri-apps/api/event");
    unlisteners.push(
      await listen<RxBatchPayload>("comm:rx", (event) => {
        const payload = event.payload;
        for (const frame of payload.frames ?? []) {
          const topic = frame.topic ?? undefined;
          if (topic && isMqttTopicPaused(payload.sessionId, topic)) continue;
          pushMessage(payload.sessionId, "rx", asBytes(frame.data), {
            timestamp: frame.timestamp,
            sourceLabel: frame.source ?? undefined,
            color: frame.color ?? undefined,
            topic,
          });
        }
      }),
    );
    unlisteners.push(
      await listen<StatusPayload>("comm:status", (event) => {
        const payload = event.payload;
        const status = payload.status as Session["status"];
        if (
          status !== "connected" &&
          status !== "connecting" &&
          status !== "disconnected" &&
          status !== "error"
        ) {
          return;
        }
        const session = sessions.value.find((s) => s.id === payload.sessionId);
        if (!session) return;
        if (status === "disconnected" && session.status === "connecting") return;
        if (session.status === status && status !== "error") return;
        applyStatus(payload.sessionId, status, payload.error);
      }),
    );
    unlisteners.push(
      await listen<PortsPayload>("comm:ports", (event) => {
        const payload = event.payload;
        serialPorts.value = payload.ports ?? [];
        if (payload.added?.length) {
          toast.message(t("err.portAdded", { list: payload.added.join(" · ") }));
        }
        if (payload.removed?.length) {
          toast.message(t("err.portRemoved", { list: payload.removed.join(" · ") }));
        }
        for (const session of sessions.value) {
          if (session.config.kind !== "serial") continue;
          if (!session.config.port && serialPorts.value[0]) {
            session.config.port = serialPorts.value[0].name;
          }
        }
      }),
    );
    unlisteners.push(
      await listen<ClientsPayload>("comm:clients", (event) => {
        const payload = event.payload;
        tcpClients[payload.sessionId] = payload.clients ?? [];
        const target = tcpTarget[payload.sessionId];
        if (target && target !== "all" && !(payload.clients ?? []).some((c) => c.id === target)) {
          tcpTarget[payload.sessionId] = "all";
        }
      }),
    );
    try {
      serialPorts.value = await invokeListPorts();
    } catch {
      serialPorts.value = [];
    }
  }

  function unbindBackend() {
    for (const stop of unlisteners) stop();
    unlisteners = [];
    bound = false;
  }

  const pendingInsert = pendingComposerInsert;

  function snapshot(): SessionSnapshot[] {
    return sessions.value.map((s) => ({
      id: s.id,
      name: s.name,
      protocol: s.protocol,
      createdAt: s.createdAt,
      config: s.config,
      mqttSubs: mqttSubs[s.id] ?? [],
      mqttMuted: mqttMuted[s.id] ?? {},
      topicFilter: topicFilter[s.id] ?? "",
      displayMode: displayMode[s.id],
      composer: composer[s.id] ?? { draft: "", mode: defaultMode(s.protocol) },
      aiMessages: s.protocol === "ai" ? useAiStore().messagesOf(s.id) : undefined,
    }));
  }

  function hydrate(
    list: SessionSnapshot[],
    lastId: string | null,
    savedHistory?: SendHistoryItem[],
  ) {
    if (sessions.value.length > 0 || list.length === 0) return;
    for (const item of list) {
      if (!(item.protocol in PROTOCOL_META)) continue;
      const session: Session = {
        id: item.id,
        name: item.name,
        protocol: item.protocol,
        status: "disconnected",
        createdAt: item.createdAt,
        lastActiveAt: Date.now(),
        rxBytes: 0,
        txBytes: 0,
        rxFrames: 0,
        txFrames: 0,
        config: restoreConfig(item.protocol, item.config),
      };
      sessions.value.push(session);
      initSessionState(session, item);
    }
    if (Array.isArray(savedHistory) && savedHistory.length) {
      history.value = savedHistory.slice(0, HISTORY_CAP);
    }
    if (lastId && sessions.value.some((s) => s.id === lastId)) {
      activeId.value = lastId;
    }
  }

  return {
    sessions,
    activeId,
    messages,
    displayMode,
    autoScroll,
    history,
    serialPorts,
    tcpClients,
    tcpTarget,
    mqttSubs,
    mqttMuted,
    topicFilter,
    sending,
    activeSession,
    filteredSessions,
    recentSessions,
    activeMessages,
    visibleMessages,
    createSession,
    selectSession,
    activateRail,
    importSessions,
    mergeHistory,
    closeSession,
    requestClose,
    renameSession,
    updateConfig,
    applyStatus,
    toggleConnect,
    sendToSession,
    resend,
    resendHistory,
    clearMessages,
    resetCounters,
    selectedIds,
    selectedCount,
    isSelected,
    selectMessage,
    clearSelection,
    selectAfterLastTx,
    selectedRx,
    switchNext,
    setDisplayMode,
    setAutoScroll,
    setTcpTarget,
    kickClient,
    subscribeMqtt,
    replaceMqttSub,
    unsubscribeMqtt,
    setTopicFilter,
    mqttTopicEntries,
    toggleMqttTopic,
    isMqttTopicPaused,
    bindBackend,
    unbindBackend,
    pendingInsert,
    insertToComposer,
    snapshot,
    hydrate,
    composerOf,
  };
});
