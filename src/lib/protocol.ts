import type {
  AiConfig,
  DbConfig,
  DbEngine,
  FtpConfig,
  ProtocolType,
  RailId,
  Session,
  SessionConfig,
  SshAuth,
  SshConfig,
  SshEndpoint,
} from "@/types";
import { t } from "@/i18n";

export const PROTOCOL_META: Record<
  ProtocolType,
  { rail: RailId; prefix: string }
> = {
  serial: { rail: "serial", prefix: "串口" },
  tcp: { rail: "network", prefix: "TCP-" },
  udp: { rail: "network", prefix: "UDP-" },
  websocket: { rail: "network", prefix: "WS-" },
  mqtt: { rail: "mqtt", prefix: "MQTT-" },
  http: { rail: "http", prefix: "HTTP-" },
  ssh: { rail: "ssh", prefix: "SSH-" },
  ftp: { rail: "ftp", prefix: "FTP-" },
  db: { rail: "db", prefix: "DB-" },
  ai: { rail: "ai", prefix: "AI-" },
};

export function protocolLabel(protocol: ProtocolType): string {
  return t(`proto.${protocol}`);
}

export function protocolShort(protocol: ProtocolType): string {
  return protocol === "serial" ? t("proto.serialShort") : PROTOCOL_META[protocol].prefix.replace(/-$/, "") || t(`proto.${protocol}`);
}

export const RAIL_PROTOCOLS: Record<RailId, ProtocolType[] | null> = {
  serial: ["serial"],
  network: ["tcp", "udp", "websocket"],
  mqtt: ["mqtt"],
  http: ["http"],
  ssh: ["ssh"],
  ftp: ["ftp"],
  db: ["db"],
  ai: ["ai"],
  net: null,
  modbus: null,
  tools: null,
  settings: null,
};

export function randomClientId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `fs_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function defaultConfig(protocol: ProtocolType): SessionConfig {
  switch (protocol) {
    case "serial":
      return {
        kind: "serial",
        port: "",
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      };
    case "tcp":
      return {
        kind: "tcp",
        mode: "client",
        host: "127.0.0.1",
        port: 8080,
      };
    case "udp":
      return {
        kind: "udp",
        localPort: 9000,
        remoteHost: "127.0.0.1",
        remotePort: 9000,
      };
    case "websocket":
      return {
        kind: "websocket",
        url: "ws://127.0.0.1:8080",
        messageMode: "text",
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        heartbeatPayload: "ping",
      };
    case "mqtt":
      return {
        kind: "mqtt",
        broker: "127.0.0.1",
        port: 1883,
        clientId: "",
        username: "",
        password: "",
        keepAlive: 60,
        cleanSession: true,
        publishTopic: "test",
        publishQos: 0,
        tls: false,
      };
    case "http":
      return {
        kind: "http",
        method: "GET",
        url: "http://127.0.0.1:8080",
        params: [{ key: "", value: "" }],
        headers: [{ key: "", value: "" }],
        body: "",
        authType: "none",
        authUser: "",
        authPass: "",
        authToken: "",
      };
    case "ssh":
      return normalizeSshConfig(undefined);
    case "ftp":
      return normalizeFtpConfig(undefined);
    case "db":
      return normalizeDbConfig(undefined);
    case "ai":
      return normalizeAiConfig(undefined);
  }
}

export function emptyAuth(): SshAuth {
  return { method: "password", password: "", keyPath: "", keyPassphrase: "" };
}

export function emptyEndpoint(): SshEndpoint {
  return { host: "", port: 22, user: "root", auth: emptyAuth() };
}

export function normalizeAiConfig(cfg: Partial<AiConfig> | undefined): AiConfig {
  return {
    kind: "ai",
    baseUrl: cfg?.baseUrl?.trim() || "http://127.0.0.1:11434/v1",
    apiKey: cfg?.apiKey ?? "",
    model: cfg?.model ?? "",
  };
}

export function dbDefaultPort(engine: DbEngine): number {
  if (engine === "mysql") return 3306;
  if (engine === "sqlserver") return 1433;
  return 5432;
}

function dbDefaultUser(engine: DbEngine): string {
  if (engine === "mysql") return "root";
  if (engine === "sqlserver") return "sa";
  return "postgres";
}

function dbDefaultDatabase(engine: DbEngine): string {
  if (engine === "mysql" || engine === "sqlserver") return "";
  return "postgres";
}

function asDbEngine(value: string | undefined): DbEngine {
  if (value === "mysql" || value === "sqlite" || value === "sqlserver") return value;
  return "postgres";
}

export function normalizeDbConfig(cfg: Partial<DbConfig> | undefined): DbConfig {
  const engine = asDbEngine(cfg?.engine);
  return {
    kind: "db",
    engine,
    host: cfg?.host ?? "127.0.0.1",
    port: Number(cfg?.port) || dbDefaultPort(engine),
    database: cfg?.database ?? dbDefaultDatabase(engine),
    user: cfg?.user ?? dbDefaultUser(engine),
    password: cfg?.password ?? "",
    file: cfg?.file ?? "",
    selectOnly: Boolean(cfg?.selectOnly),
    sql: cfg?.sql ?? "",
  };
}

export function normalizeFtpConfig(cfg: Partial<FtpConfig> | undefined): FtpConfig {
  return {
    kind: "ftp",
    host: cfg?.host ?? "127.0.0.1",
    port: Number(cfg?.port) || 21,
    user: cfg?.user ?? "anonymous",
    password: cfg?.password ?? "",
  };
}

export function normalizeSshConfig(cfg: Partial<SshConfig> | undefined): SshConfig {
  const jump = cfg?.jump;
  return {
    kind: "ssh",
    host: cfg?.host ?? "127.0.0.1",
    port: Number(cfg?.port) || 22,
    user: cfg?.user ?? "root",
    auth: { ...emptyAuth(), ...cfg?.auth },
    jumpEnabled: Boolean(cfg?.jumpEnabled),
    jump: {
      ...emptyEndpoint(),
      ...jump,
      port: Number(jump?.port) || 22,
      auth: { ...emptyAuth(), ...jump?.auth },
    },
    tunnels: Array.isArray(cfg?.tunnels) ? cfg.tunnels : [],
  };
}

export function nextSessionName(
  protocol: ProtocolType,
  sessions: Session[],
): string {
  const prefix = protocol === "serial" ? t("proto.serialPrefix") : PROTOCOL_META[protocol].prefix;
  const used = new Set(
    sessions.filter((s) => s.protocol === protocol).map((s) => s.name),
  );
  let n = 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function sessionEndpoint(session: Session): string {
  const cfg = session.config;
  switch (cfg.kind) {
    case "serial":
      return cfg.port || t("bar.noPort");
    case "tcp":
      return cfg.mode === "server"
        ? t("bar.listen", { port: cfg.port })
        : `${cfg.host}:${cfg.port}`;
    case "udp":
      return `${cfg.localPort} → ${cfg.remoteHost}:${cfg.remotePort}`;
    case "websocket":
      return cfg.url || t("bar.noUrl");
    case "mqtt":
      return `${cfg.tls ? "mqtts://" : ""}${cfg.broker}:${cfg.port}`;
    case "http":
      return cfg.url || t("bar.noUrl");
    case "ssh":
      return `${cfg.user}@${cfg.host}:${cfg.port}`;
    case "ftp":
      return `${cfg.user}@${cfg.host}:${cfg.port}`;
    case "db":
      return cfg.engine === "sqlite"
        ? cfg.file || t("bar.noFile")
        : `${cfg.engine} ${cfg.host}:${cfg.port}/${cfg.database || "—"}`;
    case "ai":
      return cfg.model.trim() || cfg.baseUrl || t("bar.notConfigured");
  }
}

export function sessionSummary(session: Session): string {
  const endpoint = sessionEndpoint(session);
  const total = session.rxBytes + session.txBytes;
  if (total <= 0) return endpoint;
  return `${endpoint} · ${total}`;
}

export function statusLabel(status: Session["status"]): string {
  switch (status) {
    case "connected":
      return t("status.connected");
    case "connecting":
      return t("status.connecting");
    case "error":
      return t("status.error");
    default:
      return t("status.disconnected");
  }
}

export function connectionParams(session: Session): string {
  const cfg = session.config;
  switch (cfg.kind) {
    case "serial": {
      const parity =
        cfg.parity === "none" ? "N" : cfg.parity === "even" ? "E" : "O";
      return `${cfg.baudRate},${cfg.dataBits}${parity}${cfg.stopBits}`;
    }
    case "tcp":
      return cfg.mode === "server" ? `TCP Server :${cfg.port}` : `TCP ${cfg.host}:${cfg.port}`;
    case "udp":
      return `UDP ${cfg.localPort}`;
    case "websocket":
      return cfg.messageMode === "text" ? "Text" : "Binary";
    case "mqtt":
      return `${cfg.tls ? "TLS · " : ""}KeepAlive ${cfg.keepAlive}s`;
    case "http":
      return cfg.method;
    case "ssh":
      return `${cfg.user}@${cfg.host}:${cfg.port}`;
    case "ftp":
      return `FTP ${cfg.host}:${cfg.port}`;
    case "db":
      return cfg.engine === "sqlite"
        ? "SQLite"
        : `${cfg.engine} ${cfg.host}:${cfg.port}`;
    case "ai":
      return cfg.model.trim() || t("bar.notConfigured");
  }
}
