export type ProtocolType =
  | "serial"
  | "tcp"
  | "udp"
  | "websocket"
  | "mqtt"
  | "http"
  | "ssh"
  | "ftp"
  | "db"
  | "ai";

export type RailId =
  | "serial"
  | "network"
  | "mqtt"
  | "http"
  | "ssh"
  | "ftp"
  | "db"
  | "ai"
  | "net"
  | "modbus"
  | "tools"
  | "settings";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type DataMode = "hex" | "ascii";
export type TcpMode = "client" | "server";
export type MessageDirection = "rx" | "tx" | "error";

export interface SerialConfig {
  kind: "serial";
  port: string;
  baudRate: number | string;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: "none" | "even" | "odd";
  flowControl: "none" | "hardware" | "software";
}

export interface TcpConfig {
  kind: "tcp";
  mode: TcpMode;
  host: string;
  port: number;
}

export interface UdpConfig {
  kind: "udp";
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface WsConfig {
  kind: "websocket";
  url: string;
  messageMode: "text" | "binary";
  heartbeatEnabled: boolean;
  heartbeatIntervalMs: number;
  heartbeatPayload: string;
}

export interface MqttConfig {
  kind: "mqtt";
  broker: string;
  port: number;
  clientId: string;
  username: string;
  password: string;
  keepAlive: number;
  cleanSession: boolean;
  publishTopic: string;
  publishQos: 0 | 1 | 2;
  tls: boolean;
}

export interface HttpPair {
  key: string;
  value: string;
}

export interface HttpConfig {
  kind: "http";
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
  url: string;
  params: HttpPair[];
  headers: HttpPair[];
  body: string;
  authType: "none" | "basic" | "bearer";
  authUser: string;
  authPass: string;
  authToken: string;
}

export type SshAuthMethod = "password" | "key";

export interface SshAuth {
  method: SshAuthMethod;
  password: string;
  keyPath: string;
  keyPassphrase: string;
}

export interface SshEndpoint {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
}

export type SshTunnelKind = "local" | "remote" | "dynamic";

export interface SshTunnelRule {
  id: string;
  kind: SshTunnelKind;
  bindHost: string;
  bindPort: number;
  destHost: string;
  destPort: number;
}

export interface SshConfig {
  kind: "ssh";
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  jumpEnabled: boolean;
  jump: SshEndpoint;
  tunnels: SshTunnelRule[];
}

export interface FtpConfig {
  kind: "ftp";
  host: string;
  port: number;
  user: string;
  password: string;
}

export type DbEngine = "postgres" | "mysql" | "sqlite" | "sqlserver";

export interface DbConfig {
  kind: "db";
  engine: DbEngine;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  file: string;
  selectOnly: boolean;
  sql: string;
}

export interface AiConfig {
  kind: "ai";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SshHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  jumpEnabled: boolean;
  jump: SshEndpoint;
  tunnels: SshTunnelRule[];
  tags: string[];
  favorite: boolean;
}

export interface SshFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mode: string;
  mtime: number;
}

export interface SshProbeInfo {
  os: string;
  cores: string;
  mem: string;
  disk: string;
  hostname?: string;
  distro?: string;
  osId?: string;
  ip?: string;
  load?: string;
  diskTotal?: string;
  rttMs?: number;
}

export type SessionConfig =
  | SerialConfig
  | TcpConfig
  | UdpConfig
  | WsConfig
  | MqttConfig
  | HttpConfig
  | SshConfig
  | FtpConfig
  | DbConfig
  | AiConfig;

export interface Session {
  id: string;
  name: string;
  protocol: ProtocolType;
  status: ConnectionStatus;
  createdAt: number;
  lastActiveAt: number;
  rxBytes: number;
  txBytes: number;
  rxFrames: number;
  txFrames: number;
  config: SessionConfig;
}

export interface LogMessage {
  id: string;
  sessionId: string;
  direction: MessageDirection;
  timestamp: number;
  hex: string;
  ascii: string;
  byteLength: number;
  sourceLabel?: string;
  color?: string;
  topic?: string;
}

export interface SerialPortInfo {
  name: string;
  label: string;
}

export interface TcpClientInfo {
  id: string;
  addr: string;
  color: string;
}

export interface MqttSubscription {
  topic: string;
  qos: 0 | 1 | 2;
  enabled: boolean;
}

export interface MqttTopicEntry {
  topic: string;
  count: number;
  enabled: boolean;
  isSub: boolean;
  qos?: 0 | 1 | 2;
  color: string;
}

export interface SendHistoryItem {
  id: string;
  sessionId: string;
  sessionName: string;
  mode: DataMode;
  content: string;
  timestamp: number;
}

export type SshAnsiTheme = "tango" | "one-dark" | "mocha" | "light";
export type LocalePref = "system" | "zh" | "en";

export interface AppSettings {
  theme: "dark" | "light";
  locale: LocalePref;
  startup: "restore" | "dashboard";
  logLimit: number;
  defaultEncoding: "utf8";
  httpTimeoutMs: number;
  sshAnsiTheme: SshAnsiTheme;
  sshScrollback: number;
  sshAutoReconnect: boolean;
  sshReconnectMs: number;
  sshEditMaxMb: number;
  ftpFileView: "list" | "icons";
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
}
