import { resolvedLocale } from "@/i18n";

export type PageHelpId =
  | "serial"
  | "tcp"
  | "udp"
  | "websocket"
  | "mqtt"
  | "http"
  | "ssh"
  | "ssh-hosts"
  | "ftp"
  | "db"
  | "ai"
  | "sim"
  | "net"
  | "tools"
  | "settings"
  | "dashboard";

export interface PageHelpExample {
  caption?: string;
  sample: string;
  after?: string;
}

export interface PageHelpSection {
  title: string;
  lines: string[];
  examples?: PageHelpExample[];
}

export interface PageHelpDoc {
  title: string;
  lead: string[];
  sections: PageHelpSection[];
}

export const PAGE_HELP: Record<PageHelpId, PageHelpDoc> = {
  serial: {
    title: "串口",
    lead: [
      "选端口、波特率后连接。发送栏 HEX 空格分隔字节；切 ASCII 发原文。空闲超时拼一帧 RX。",
    ],
    sections: [
      {
        title: "HEX 读保持",
        lines: ["与设备同波特率。开「校验」则发送前自动补 Modbus CRC16。"],
        examples: [
          {
            caption: "从站 1 读保持寄存器 0 起 1 个：",
            sample: "01 03 00 00 00 01",
            after: "开校验后实发 01 03 00 00 00 01 84 0A。",
          },
        ],
      },
      {
        title: "对仿真从站",
        lines: [
          "仿真「本机回环」不经操作系统，本页读不到。",
          "仿真改「串口」，主/从各选一口，须是一对虚拟串口（com0com）。",
        ],
        examples: [
          {
            caption: "COM3↔COM4：",
            sample: "仿真从站 COM3  ·  本页 COM4  ·  同波特率",
            after: "本页发 RTU，仿真左侧从站表应看到读写。",
          },
        ],
      },
    ],
  },
  tcp: {
    title: "TCP",
    lead: ["Client 填对端 host:port。Server 只填监听端口；多客户端分色，发送可指定对象。"],
    sections: [
      {
        title: "Client",
        lines: ["连已在听的服务。仿真选 TCP 并开始后，用本页读它的从站。"],
        examples: [
          {
            caption: "仿真监听 1502：",
            sample: "Client  127.0.0.1  1502",
            after: "发送栏发 Modbus TCP 请求即可。",
          },
        ],
      },
      {
        title: "Server",
        lines: ["本机监听，等对端连入。"],
        examples: [
          {
            caption: "听 9000：",
            sample: "Server  9000",
          },
        ],
      },
    ],
  },
  udp: {
    title: "UDP",
    lead: ["「本地」是本机收包端口。「远程」是发出去的目标。无连接态，谁发来都显示。"],
    sections: [
      {
        title: "收发",
        lines: ["先填本地端口再连接（开始监听）。发送一律发往远程。"],
        examples: [
          {
            caption: "本机听 9000，发给 192.168.1.10:9000：",
            sample: "本地 9000  ·  远程 192.168.1.10  9000",
          },
        ],
      },
    ],
  },
  websocket: {
    title: "WebSocket",
    lead: ["填完整 URL（含路径）。Text 发 UTF-8；Binary 发 HEX。心跳按间隔发 ping。"],
    sections: [
      {
        title: "连接",
        lines: ["明文 ws://，TLS 用 wss://。"],
        examples: [
          {
            caption: "本机服务：",
            sample: "ws://127.0.0.1:8080/ws",
          },
          {
            caption: "TLS：",
            sample: "wss://example.com/ws",
          },
        ],
      },
    ],
  },
  mqtt: {
    title: "MQTT",
    lead: [
      "Broker + 端口。连上后先订阅再发。Topic 里 + 配一层，# 配多层。TLS 口默认改 8883。",
    ],
    sections: [
      {
        title: "连接",
        lines: [
          "Client ID 空则每次连接随机，避免拷到其它电脑互踢。用户密码按 Broker 要求。",
          "macOS 15+ 连局域网需打开「本地网络」权限。",
        ],
        examples: [
          {
            caption: "本机 Mosquitto：",
            sample: "127.0.0.1  1883",
          },
        ],
      },
      {
        title: "订阅 / 发布",
        lines: ["订阅栏加 Topic，列表里可改。发送栏的 Topic 是发布目标，与订阅独立。"],
        examples: [
          {
            caption: "收传感器、往同一树发布：",
            sample: "订阅  sensor/#\n发布  sensor/temp",
          },
        ],
      },
    ],
  },
  http: {
    title: "HTTP",
    lead: [
      "方法 + 完整 URL。参数拼查询串；请求头 / 正文 / 认证分栏。Ctrl+Enter 发送。请求从本机发出，无浏览器 CORS。",
    ],
    sections: [
      {
        title: "GET",
        lines: ["无正文。查询写在 URL 或参数里。"],
        examples: [
          {
            caption: "探活：",
            sample: "GET  http://127.0.0.1:8080/api/health",
          },
        ],
      },
      {
        title: "POST JSON",
        lines: ["Content-Type 用 application/json。正文为 JSON。"],
        examples: [
          {
            caption: "登录：",
            sample: "POST  http://127.0.0.1:8080/api/login\n{\"user\":\"a\",\"pass\":\"b\"}",
          },
        ],
      },
      {
        title: "Auth",
        lines: ["Basic 填用户密码；Bearer 填 Token，自动加 Authorization。"],
      },
    ],
  },
  ssh: {
    title: "SSH",
    lead: [
      "host port user，密码或私钥。跳板、文件、隧道为面板。连上出终端；文件与隧道须已连接。",
    ],
    sections: [
      {
        title: "直连",
        lines: ["私钥选文件，口令是密钥的，不是登录密码。"],
        examples: [
          {
            caption: "密码登录：",
            sample: "192.168.1.10  22  root  密码",
          },
        ],
      },
      {
        title: "跳板",
        lines: ["先登跳板，再从跳板连目标。目标 host 以跳板为视角。"],
        examples: [
          {
            caption: "跳 192.168.1.1 → 内网 10.0.0.8：",
            sample: "目标  10.0.0.8  22  root\n跳板  192.168.1.1  22  jump",
          },
        ],
      },
      {
        title: "终端",
        lines: ["Ctrl+F 搜回看。多行粘贴先确认。文件可复制路径或 cd。"],
      },
    ],
  },
  "ssh-hosts": {
    title: "主机簿",
    lead: ["条目存本机。保存后双击按该认证连接。导入导出 JSON。"],
    sections: [
      {
        title: "新建",
        lines: ["名称仅显示用。跳板、隧道随条目一起存，连上后可改。"],
        examples: [
          {
            caption: "车间一台：",
            sample: "名称  车间PLC\n192.168.1.10  22  root  密码",
          },
        ],
      },
    ],
  },
  ftp: {
    title: "FTP",
    lead: ["host port user 密码。被动模式。连上列目录；拖入上传、拖出下载。未连接则列表空。"],
    sections: [
      {
        title: "连接",
        lines: ["列表 / 图标只改显示，不影响传输。"],
        examples: [
          {
            caption: "内网 FTP：",
            sample: "192.168.1.10  21  user  pass",
          },
        ],
      },
    ],
  },
  db: {
    title: "DB",
    lead: [
      "引擎 + 连接信息。连上后左表右 SQL。Ctrl+Enter 跑当前或选中语句。开「只 SELECT」时非查询会被拒。结果上限 1000 行。",
    ],
    sections: [
      {
        title: "连接",
        lines: [
          "SQLite 选文件，无端口用户。PG / MySQL / SQL Server 切库：连上后库名变下拉。",
          "macOS 15+ 连局域网库需要「本地网络」权限，与 MQTT 同一开关。",
        ],
        examples: [
          {
            caption: "PostgreSQL：",
            sample: "PostgreSQL  127.0.0.1  5432  库 mydb  用户 postgres",
          },
          {
            caption: "MySQL：",
            sample: "MySQL  127.0.0.1  3306  库 mydb  用户 root",
          },
          {
            caption: "SQL Server：",
            sample: "SQL Server  127.0.0.1  1433  库 mydb  用户 sa",
          },
        ],
      },
      {
        title: "SQL",
        lines: ["双击表打开一页数据。右键：打开 / 结构 / 导出 SQL。表列「导出库」出整库脚本。"],
        examples: [
          {
            sample: "SELECT * FROM t",
          },
        ],
      },
    ],
  },
  ai: {
    title: "AI",
    lead: [
      "OpenAI 兼容口。接口填到 /v1，模型名与服务一致。密钥没有可空。Ctrl+Enter 发送。不读其它页数据。",
    ],
    sections: [
      {
        title: "Ollama",
        lines: ["本机已拉模型。接口不要漏 /v1。"],
        examples: [
          {
            sample: "接口  http://127.0.0.1:11434/v1\n模型  qwen2.5\n密钥  （空）",
          },
        ],
      },
    ],
  },
  sim: {
    title: "仿真",
    lead: [
      "左从站寄存器，右主站轮询。表头 HEX/DEC 同时切地址和格子。格子失焦写 06。进页默认本机回环即跑。",
    ],
    sections: [
      {
        title: "本机回环",
        lines: [
          "不经串口、不经 TCP，串口页 / 网络页都读不到。",
          "改左侧格子，右侧下一轮读到；改右侧格子，失焦写回从站。",
        ],
      },
      {
        title: "TCP · 给外部读",
        lines: ["仿真选 TCP，填监听口，开始。从站听该口。"],
        examples: [
          {
            caption: "本机 1502：",
            sample: "TCP  127.0.0.1  1502",
            after: "网络页 Client 同地址发 03；或本页右侧主站连同一口。",
          },
        ],
      },
      {
        title: "串口 · 给外部读",
        lines: ["主/从各选一口，须成对虚拟串口。串口调试页连从站对面那口。"],
        examples: [
          {
            caption: "COM3↔COM4：",
            sample: "仿真从站 COM3  ·  串口页 COM4  ·  同波特率",
            after: "本页主站若也要跑，选这对里的另一口，不要和从站同一口。",
          },
        ],
      },
    ],
  },
  net: {
    title: "看网",
    lead: ["上栏 Tab，下栏动作记录。不接管会话连接。"],
    sections: [
      {
        title: "探测",
        lines: ["Ping 默认 4 次。扫描默认常见口，不是 1–1024。发现扫当前 /24。"],
        examples: [
          {
            sample: "Ping  127.0.0.1\n端口  127.0.0.1  80\n占用  80",
          },
        ],
      },
    ],
  },
  tools: {
    title: "工具",
    lead: ["组帧、解析、校验、JSON。不接管会话连接；有活动串口/TCP/UDP 会话时可以把生成帧发过去。"],
    sections: [
      {
        title: "Modbus 指令",
        lines: ["填从站 / 功能 / 地址 / 数量 → 生成。解析栏贴应答 HEX。点表按地址解多字节。"],
        examples: [
          {
            caption: "RTU 读保持 0 起 2 个：",
            sample: "从站 1  ·  03  ·  地址 0  ·  数量 2\n01 03 00 00 00 02 C4 0B",
          },
        ],
      },
      {
        title: "协议解析",
        lines: ["粘 HEX，选 schema。内置电表样例可先跑通。自定义 schema 可导入。"],
      },
    ],
  },
  settings: {
    title: "设置",
    lead: ["本机保存。恢复上次还原会话配置，不含当时已打开的连接。SSH 配色随界面深浅。"],
    sections: [
      {
        title: "启动",
        lines: ["「恢复上次会话」下次打开仍是那些会话，须再连。选「空会话」进主页。"],
      },
    ],
  },
  dashboard: {
    title: "飞梭",
    lead: ["无会话时的主页。侧栏协议建会话；看网、仿真、工具不建会话。"],
    sections: [
      {
        title: "仿真",
        lines: [
          "侧栏「仿真」：Modbus 主从实验室。默认回环。要让串口页读到，仿真改串口并配虚拟串口对。",
        ],
      },
    ],
  },
};

export function pageHelp(id: PageHelpId): PageHelpDoc {
  const en = PAGE_HELP_EN?.[id];
  return resolvedLocale.value === "en" && en ? en : PAGE_HELP[id];
}

export const PAGE_HELP_EN: Record<PageHelpId, PageHelpDoc> = {
  serial: {
    title: "Serial",
    lead: [
      "Pick port and baud, then connect. HEX send is space-separated bytes; ASCII sends raw text. Idle timeout assembles one RX frame.",
    ],
    sections: [
      {
        title: "HEX read holding",
        lines: ["Same baud as the device. Checksum appends Modbus CRC16 before send."],
        examples: [
          {
            caption: "Slave 1, holding from 0, count 1:",
            sample: "01 03 00 00 00 01",
            after: "With checksum: 01 03 00 00 00 01 84 0A.",
          },
        ],
      },
      {
        title: "Against Lab slave",
        lines: [
          "Lab loopback never hits the OS; this page cannot see it.",
          "Lab set to Serial: master and slave each pick a port — a virtual pair (com0com).",
        ],
        examples: [
          {
            caption: "COM3↔COM4:",
            sample: "Lab slave COM3  ·  this page COM4  ·  same baud",
            after: "This page sends RTU; Lab slave table on the left should show the R/W.",
          },
        ],
      },
    ],
  },
  tcp: {
    title: "TCP",
    lead: ["Client: peer host:port. Server: listen port only. Multiple clients are color-coded; send can target one."],
    sections: [
      {
        title: "Client",
        lines: ["Connect to a listening service. After Lab starts as TCP, this page reads its slave."],
        examples: [
          {
            caption: "Lab listen 1502:",
            sample: "Client  127.0.0.1  1502",
            after: "Send a Modbus TCP request from the send bar.",
          },
        ],
      },
      {
        title: "Server",
        lines: ["Listen on this host; wait for peers."],
        examples: [
          {
            caption: "Listen 9000:",
            sample: "Server  9000",
          },
        ],
      },
    ],
  },
  udp: {
    title: "UDP",
    lead: ["Local is the bind port. Remote is the send target. No connection state; all senders show."],
    sections: [
      {
        title: "Send / receive",
        lines: ["Fill local port, then connect (start listen). Send always goes to remote."],
        examples: [
          {
            caption: "Listen 9000, send to 192.168.1.10:9000:",
            sample: "Local 9000  ·  Remote 192.168.1.10  9000",
          },
        ],
      },
    ],
  },
  websocket: {
    title: "WebSocket",
    lead: ["Full URL including path. Text is UTF-8; Binary is HEX. Heartbeat sends ping at the interval."],
    sections: [
      {
        title: "Connect",
        lines: ["Plain ws://. TLS uses wss://."],
        examples: [
          {
            caption: "Local service:",
            sample: "ws://127.0.0.1:8080/ws",
          },
          {
            caption: "TLS:",
            sample: "wss://example.com/ws",
          },
        ],
      },
    ],
  },
  mqtt: {
    title: "MQTT",
    lead: [
      "Broker + port. Subscribe first, then publish. + is one level, # is multi. TLS default port 8883.",
    ],
    sections: [
      {
        title: "Connect",
        lines: [
          "Empty Client ID is random each connect, so copies on other PCs don't collide. User/password as the Broker requires.",
          "macOS 15+ needs Local Network permission for LAN brokers.",
        ],
        examples: [
          {
            caption: "Local Mosquitto:",
            sample: "127.0.0.1  1883",
          },
        ],
      },
      {
        title: "Subscribe / Publish",
        lines: ["Subscribe bar adds topics; the list can edit them. Send-bar topic is the publish target, independent of subscribe."],
        examples: [
          {
            caption: "Sensors in, same tree out:",
            sample: "Sub  sensor/#\nPub  sensor/temp",
          },
        ],
      },
    ],
  },
  http: {
    title: "HTTP",
    lead: [
      "Method + full URL. Params append the query; headers, body, and auth are tabs. Ctrl+Enter sends. Requests leave this host — no browser CORS.",
    ],
    sections: [
      {
        title: "GET",
        lines: ["No body. Query sits on the URL or in Params."],
        examples: [
          {
            caption: "Health:",
            sample: "GET  http://127.0.0.1:8080/api/health",
          },
        ],
      },
      {
        title: "POST JSON",
        lines: ["Content-Type application/json. Body is the JSON object."],
        examples: [
          {
            caption: "Login:",
            sample: "POST  http://127.0.0.1:8080/api/login\n{\"user\":\"a\",\"pass\":\"b\"}",
          },
        ],
      },
      {
        title: "Auth",
        lines: ["Basic: user and password. Bearer: token. Authorization is added."],
      },
    ],
  },
  ssh: {
    title: "SSH",
    lead: [
      "host port user, password or key. Jump, files, tunnels are panels. Connect opens the terminal; files and tunnels need a live session.",
    ],
    sections: [
      {
        title: "Direct",
        lines: ["Key is a file. Passphrase is for the key, not the login password."],
        examples: [
          {
            caption: "Password login:",
            sample: "192.168.1.10  22  root  password",
          },
        ],
      },
      {
        title: "Jump",
        lines: ["Log into the jump first, then from there to the target. Target host is from the jump's view."],
        examples: [
          {
            caption: "Jump 192.168.1.1 → 10.0.0.8:",
            sample: "Target  10.0.0.8  22  root\nJump  192.168.1.1  22  jump",
          },
        ],
      },
      {
        title: "Terminal",
        lines: ["Ctrl+F searches scrollback. Multiline paste confirms first. Files can copy path or cd."],
      },
    ],
  },
  "ssh-hosts": {
    title: "SSH hosts",
    lead: ["Entries live on this machine. After save, double-click connects with that auth. Import/export JSON."],
    sections: [
      {
        title: "New",
        lines: ["Name is display only. Jump and tunnels store with the entry; editable after connect."],
        examples: [
          {
            caption: "One shop-floor host:",
            sample: "Name  Shop PLC\n192.168.1.10  22  root  password",
          },
        ],
      },
    ],
  },
  ftp: {
    title: "FTP",
    lead: [
      "host port user password. Passive mode. Connect lists the dir; drag in to upload, drag out to download. Disconnected list is empty.",
    ],
    sections: [
      {
        title: "Connect",
        lines: ["List / icon only changes the view, not the transfer."],
        examples: [
          {
            caption: "LAN FTP:",
            sample: "192.168.1.10  21  user  pass",
          },
        ],
      },
    ],
  },
  db: {
    title: "DB",
    lead: [
      "Engine + connect info. After connect: tables left, SQL right. Ctrl+Enter runs current or selected statement. SELECT-only rejects non-queries. Result cap 1000 rows.",
    ],
    sections: [
      {
        title: "Connect",
        lines: [
          "SQLite: file, no port or user. PG / MySQL / SQL Server: after connect, database name becomes a dropdown.",
          "macOS 15+ needs Local Network permission for LAN databases, same toggle as MQTT.",
        ],
        examples: [
          {
            caption: "PostgreSQL:",
            sample: "PostgreSQL  127.0.0.1  5432  db mydb  user postgres",
          },
          {
            caption: "MySQL:",
            sample: "MySQL  127.0.0.1  3306  db mydb  user root",
          },
          {
            caption: "SQL Server:",
            sample: "SQL Server  127.0.0.1  1433  db mydb  user sa",
          },
        ],
      },
      {
        title: "SQL",
        lines: ["Double-click opens one page of rows. Right-click: Open / Structure / Export SQL. Sidebar Export DB writes the whole catalog."],
        examples: [
          {
            sample: "SELECT * FROM t",
          },
        ],
      },
    ],
  },
  ai: {
    title: "AI",
    lead: [
      "OpenAI-compatible API. Endpoint through /v1. Model name matches the service. Key may be empty. Ctrl+Enter sends. Does not read other pages.",
    ],
    sections: [
      {
        title: "Ollama",
        lines: ["Local models already pulled. Endpoint must include /v1."],
        examples: [
          {
            sample: "API  http://127.0.0.1:11434/v1\nModel  qwen2.5\nKey  (empty)",
          },
        ],
      },
    ],
  },
  sim: {
    title: "Lab",
    lead: [
      "Registers left, master poll right. HEX/DEC header switches addresses and cells together. Blur writes 06. Entering the page starts local loopback.",
    ],
    sections: [
      {
        title: "Local loopback",
        lines: [
          "No serial, no TCP. Serial / network pages cannot see it.",
          "Change a left cell, the next right poll reads it; change a right cell, blur writes the slave.",
        ],
      },
      {
        title: "TCP · external read",
        lines: ["Lab as TCP, fill listen port, start. Slave listens there."],
        examples: [
          {
            caption: "Local 1502:",
            sample: "TCP  127.0.0.1  1502",
            after: "Network Client same address, function 03; or this page's master to the same port.",
          },
        ],
      },
      {
        title: "Serial · external read",
        lines: ["Master and slave each pick a port — a virtual pair. Serial page connects the opposite of the slave."],
        examples: [
          {
            caption: "COM3↔COM4:",
            sample: "Lab slave COM3  ·  Serial page COM4  ·  same baud",
            after: "If this page's master also runs, pick the other of the pair, not the slave's port.",
          },
        ],
      },
    ],
  },
  net: {
    title: "Net watch",
    lead: ["Tabs on top, action log below. Does not own a session."],
    sections: [
      {
        title: "Probe",
        lines: ["Ping defaults to 4. Scan uses common ports, not 1–1024. Discover sweeps the current /24."],
        examples: [
          {
            sample: "Ping  127.0.0.1\nPort  127.0.0.1  80\nOwner  80",
          },
        ],
      },
    ],
  },
  tools: {
    title: "Tools",
    lead: [
      "Frame, parse, checksum, JSON. Does not own a session. An active serial/TCP/UDP session can take a generated frame.",
    ],
    sections: [
      {
        title: "Modbus command",
        lines: ["Slave / function / address / count → generate. Parse bar takes response HEX. Point table decodes multi-byte by address."],
        examples: [
          {
            caption: "RTU read holding from 0, count 2:",
            sample: "Slave 1  ·  03  ·  addr 0  ·  count 2\n01 03 00 00 00 02 C4 0B",
          },
        ],
      },
      {
        title: "Frame parse",
        lines: ["Paste HEX, pick a schema. Built-in meter sample can be run first. Custom schema can be imported."],
      },
    ],
  },
  settings: {
    title: "Settings",
    lead: [
      "Saved locally. Restore last session restores configs, not the then-open connections. SSH colors follow the UI theme.",
    ],
    sections: [
      {
        title: "Startup",
        lines: ["Restore last session: those sessions return next launch, still need connect. Empty session opens the home page."],
      },
    ],
  },
  dashboard: {
    title: "飞梭",
    lead: ["Home when no session. Sidebar protocols create a session; Watch, Lab and Tools do not."],
    sections: [
      {
        title: "Lab",
        lines: [
          "Sidebar Lab: Modbus master/slave lab. Default loopback. For the serial page to see it, Lab uses serial and a virtual pair.",
        ],
      },
    ],
  },
};

