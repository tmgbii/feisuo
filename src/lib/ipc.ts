import { isTauri } from "@tauri-apps/api/core";
import type { SerialPortInfo, SessionConfig } from "@/types";
import { translateError } from "@/i18n";

export { isTauri };
export type { SerialPortInfo };

export interface InvokeSendOpts {
  mqttTopic?: string;
  mqttQos?: number;
  tcpClientId?: string;
  wsText?: boolean;
}

export async function invokeConnect(sessionId: string, config: SessionConfig) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("connect_session", { sessionId, config });
}

export async function invokeDisconnect(sessionId: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("disconnect_session", { sessionId });
}

export async function invokeSend(
  sessionId: string,
  data: number[],
  opts?: InvokeSendOpts,
) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("send_session", { sessionId, data, opts: opts ?? null });
}

export async function invokeMqttSub(sessionId: string, topic: string, qos: number) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mqtt_subscribe", { sessionId, topic, qos });
}

export async function invokeMqttUnsub(sessionId: string, topic: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mqtt_unsubscribe", { sessionId, topic });
}

export async function invokeKick(sessionId: string, clientId: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("kick_tcp_client", { sessionId, clientId });
}

export async function invokeListPorts(): Promise<SerialPortInfo[]> {
  if (!isTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SerialPortInfo[]>("list_serial_ports");
}

export function errorMessage(err: unknown): string {
  let raw = "";
  if (typeof err === "string") raw = err;
  else if (err instanceof Error && err.message) raw = err.message;
  else if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message) raw = message;
  }
  if (!raw) raw = String(err);
  return translateError(raw);
}

export interface HttpRequestPayload {
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body?: string | null;
  timeoutMs: number;
}

export interface HttpResponsePayload {
  status: number;
  statusText: string;
  headers: { key: string; value: string }[];
  body: string;
  truncated: boolean;
  timeMs: number;
  byteLength: number;
}

export async function invokeHttp(req: HttpRequestPayload): Promise<HttpResponsePayload> {
  if (!isTauri()) {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      const headers = new Headers();
      for (const h of req.headers) {
        if (h.key.trim()) headers.set(h.key.trim(), h.value);
      }
      const started = Date.now();
      const res = await fetch(req.url, {
        method: req.method,
        headers,
        body: req.body || undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      return {
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()].map(([key, value]) => ({ key, value })),
        body: text.slice(0, 5 * 1024 * 1024),
        truncated: text.length > 5 * 1024 * 1024,
        timeMs: Date.now() - started,
        byteLength: new TextEncoder().encode(text).length,
      };
    } finally {
      window.clearTimeout(timer);
    }
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<HttpResponsePayload>("http_request", { req });
}

export async function saveAppState(json: string) {
  if (!isTauri()) {
    localStorage.setItem("commbox-state", json);
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_app_state", { json });
}

export async function loadAppState(): Promise<string | null> {
  if (!isTauri()) return localStorage.getItem("commbox-state");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("load_app_state");
}

export async function invokeAiChat(req: {
  sessionId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: string; content: string }[];
}) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ai_chat", { req });
}

export async function invokeAiStop() {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ai_stop");
}

export interface SshConnectReq {
  sessionId: string;
  host: string;
  port: number;
  user: string;
  auth: { method: string; password: string; keyPath: string; keyPassphrase: string };
  cols: number;
  rows: number;
  jump?: {
    host: string;
    port: number;
    user: string;
    auth: { method: string; password: string; keyPath: string; keyPassphrase: string };
  } | null;
}

export async function invokeSsh<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function pickLocalFiles(opts?: {
  multiple?: boolean;
  title?: string;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string[]> {
  if (!isTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const directory = opts?.directory ?? false;
  const picked = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: {
      multiple: directory ? false : (opts?.multiple ?? false),
      directory,
      title: opts?.title,
      filters: opts?.filters,
    },
  });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("plugin:dialog|save", {
    options: { defaultPath: defaultName },
  });
}

export async function invokeAppQuit() {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("app_quit");
}

export async function writeLocalFile(path: string, content: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ssh_write_local", { path, content });
}

export interface NetdiagPingReq {
  host: string;
  count: number;
  size: number;
  intervalMs: number;
  timeoutMs: number;
}

export interface NetdiagPingReply {
  seq: number;
  ttl: number | null;
  rttMs: number | null;
  ok: boolean;
  error: string | null;
}

export interface NetdiagPingDone {
  sent: number;
  recv: number;
  loss: number;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  degraded: boolean;
  action: string;
}

export interface NetdiagPortReq {
  host: string;
  port: number;
  timeoutMs: number;
}

export interface NetdiagPortResult {
  open: boolean;
  timeMs: number;
  error: string | null;
  action: string;
}

export interface NetdiagIface {
  name: string;
  up: boolean;
  ip: string;
  mask: string;
  mac: string;
}

export interface NetdiagHostInfo {
  ifaces: NetdiagIface[];
  egress: string;
  gateway: string;
  dns: string[];
  action: string;
}

export interface NetdiagRoute {
  dest: string;
  mask: string;
  gateway: string;
  iface: string;
  metric: string;
  isDefault: boolean;
}

export interface NetdiagRouteInfo {
  routes: NetdiagRoute[];
  action: string;
}

export interface NetdiagSock {
  proto: string;
  local: string;
  remote: string;
  state: string;
  pid: string;
  name: string;
}

export interface NetdiagSocksInfo {
  rows: NetdiagSock[];
  action: string;
}

export interface NetdiagScanHit {
  port: number;
  open: boolean;
  timeMs: number;
  error: string | null;
}

export interface NetdiagScanDone {
  open: number[];
  total: number;
  action: string;
}

export interface NetdiagLanHost {
  ip: string;
  rttMs: number | null;
  mac: string;
  name: string;
}

export interface NetdiagLanDone {
  up: number;
  total: number;
  action: string;
}

export interface NetdiagArpInfo {
  rows: NetdiagLanHost[];
  action: string;
}

export interface NetdiagDnsInfo {
  host: string;
  addrs: string[];
  action: string;
}

export interface NetdiagTraceHop {
  hop: number;
  ip: string;
  rttMs: number | null;
  error: string | null;
}

export interface NetdiagTraceDone {
  hops: number;
  action: string;
}

export async function invokeNetdiagPingStart(req: NetdiagPingReq): Promise<string> {
  if (!isTauri()) throw new Error("needDesktop");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("netdiag_ping_start", { req });
}

export async function invokeNetdiagPingStop() {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("netdiag_ping_stop");
}

export async function invokeNetdiagPort(req: NetdiagPortReq): Promise<NetdiagPortResult> {
  if (!isTauri()) throw new Error("needDesktop");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NetdiagPortResult>("netdiag_port", { req });
}

export async function invokeNetdiagHost(): Promise<NetdiagHostInfo> {
  if (!isTauri()) throw new Error("needDesktop");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NetdiagHostInfo>("netdiag_host");
}

export async function invokeNetdiagRoutes(): Promise<NetdiagRouteInfo> {
  if (!isTauri()) throw new Error("needDesktop");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NetdiagRouteInfo>("netdiag_routes");
}

export async function invokeNetdiagSocks(port: number, listenOnly: boolean): Promise<NetdiagSocksInfo> {
  if (!isTauri()) throw new Error("needDesktop");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NetdiagSocksInfo>("netdiag_socks", { req: { port, listenOnly } });
}

export async function invokeNetdiagScanStart(host: string, ports: string, timeoutMs: number): Promise<string> {
  if (!isTauri()) throw new Error("needDesktop");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("netdiag_scan_start", { req: { host, ports, timeoutMs } });
}

export async function invokeNetdiagScanStop() {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("netdiag_scan_stop");
}

export async function invokeNetdiagLanStart(): Promise<string> {
  if (!isTauri()) throw new Error("needDesktop");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("netdiag_lan_start");
}

export async function invokeNetdiagLanStop() {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("netdiag_lan_stop");
}

export async function invokeNetdiagArp(): Promise<NetdiagArpInfo> {
  if (!isTauri()) throw new Error("needDesktop");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NetdiagArpInfo>("netdiag_arp");
}

export async function invokeNetdiagDns(host: string): Promise<NetdiagDnsInfo> {
  if (!isTauri()) throw new Error("needDesktop");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NetdiagDnsInfo>("netdiag_dns", { host });
}

export async function invokeNetdiagTraceStart(host: string): Promise<string> {
  if (!isTauri()) throw new Error("needDesktop");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("netdiag_trace_start", { req: { host } });
}

export async function invokeNetdiagTraceStop() {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("netdiag_trace_stop");
}
