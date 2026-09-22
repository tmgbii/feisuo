> 关键词 / Keywords：串口调试 serial-port · 网络调试 network-tools · Modbus · MQTT · SSH · 协议解析 protocol-analyzer · 跨平台 cross-platform · Tauri · Rust

# 飞梭 (Feisuo)

现代通信调试工具箱 (Feisuo) — 本地离线的串口 / TCP / UDP / WebSocket / MQTT / HTTP 调试工具。

---

# 🚀 Feisuo (飞梭)

> **现代、轻量、跨平台的通信调试与开发辅助工具箱。**
> 受够了老旧的 WinForm 串口助手和臃肿的调试软件？用这一个 20MB 的 App，替代你桌面上的 10 个工具。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Tauri](https://img.shields.io/badge/Tauri-2.x-orange.svg)
![Rust](https://img.shields.io/badge/Rust-1.70+-brown.svg)
![Vue](https://img.shields.io/badge/Vue-3.x-green.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)

---

## 序

这个工具的起点，是一个数据采集项目。

那段时间，我桌上摊着一堆调试工具：串口助手看设备、网络助手测链路、MQTT 客户端盯上报、HTTP 工具调接口。装一个、切一个，来回横跳；有的是绿色免安装的小工具，有的动辄几百 M，启动半天。某天又一次在三个窗口之间复制粘贴 HEX 的时候，我突然想：**与其伺候一堆工具，不如把它们合起来，做一个自己的工具箱。**

于是先做了串口、网络、MQTT、HTTP 四件套。用着用着发现，开发运维时那些零碎的活——连 SSH、查数据库、看网络、算校验——其实也是同一类摩擦。于是一部分开发运维工具也收了进来。

飞梭不是什么都能做的瑞士军刀，它只是把我每天重复的摩擦，收进一个 20MB 的壳里。如果你也被工具碎片化折磨过，希望它对你也有用。

值得一提的是，飞梭的大部分代码是在 AI 的深度辅助下完成的。在这个过程中，我负责死磕一线痛点、定义产品边界、做减法；而 AI 负责填补 Rust 与 Vue 的实现细节。 这不仅是一个工具箱，也是一次人类产品直觉与 AI 编程能力深度协作的实验。如果你也对这种全新的开发范式感兴趣，欢迎查阅源码，感受 AI 时代独立开发的魅力。

## 💡 为什么需要 Feisuo？

在日常的 IoT 实施、后端开发、硬件联调和服务器运维中，我们常常需要打开一堆工具：NetAssist 测串口、MQTTX 测物联网、Postman 测接口、Xshell 连 SSH、DBeaver 查数据库、Wireshark 抓包……

**Feisuo (飞梭)** 旨在终结这种“工具碎片化”。它基于 **Tauri 2.x + Rust + Vue 3** 构建，将 7 种核心通讯协议、SSH 终端、轻量数据库查询、网络诊断和协议解析融合在一个**极简、现代、离线可用**的桌面应用中。

**核心承诺**：

- 🪶 **极致轻量**：安装包 < 20MB，冷启动 < 2s，空闲内存 < 200MB。
- 🔒 **绝对隐私**：本地化运行，通讯会话数据绝不出本机。
- 🎨 **现代美学**：告别灰白大边框，采用 Linear/Raycast 风格的暗色设计语言与卡片化消息流。

---



## ✨ 核心特性



### 📡 7 大核心通讯协议

- **Serial (串口)**：支持热插拔监听、热拔保护、自定义波特率。
- **TCP / UDP**：支持 TCP Server 多客户端分色管理、UDP 广播。
- **WebSocket**：支持 Text/Binary 模式、心跳保活、自定义 Header。
- **MQTT**：全功能 MQTT 5.0 客户端，支持通配符订阅、QoS、TLS。
- **HTTP**：绕过浏览器 CORS 限制，支持环境变量、断言脚本、Postman 导入。
- **SSH 终端**：基于 xterm.js 的直通渲染，支持 TOFU 指纹校验、断线重连、多行粘贴防误触。



### 🛠️ 极客专属工具箱

- **🧩 通用协议解析 (Schema Engine)**：抛弃硬编码！通过声明式 JSON Schema 定义帧头/帧尾/长度/校验/字段，实时对 HEX 流进行切帧、解码和验算。（完美适配私有协议与非标协议）。
- **🔄 Modbus 仿真实验室**：内置 Poll (主站) 与 Slave (从站) 模拟器，支持内存/TCP 回环，无需真实硬件即可闭环测试 Modbus 逻辑。
- **🌐 看网 (网络诊断)**：免特权的网络探针。Ping、单端口测试、局域网设备发现、路由表查看、DNS 追踪，部署服务器时的“瑞士军刀”。



### 💻 现代 SSH 与 SFTP

- **文件抽屉**：SFTP 无缝集成，支持拖拽上传/下载、递归删除、路径一键复制并 `cd`。
- **跳板与隧道**：支持 `-J` 一跳跳板机，支持 `-L/-R/-D` 端口转发，一键将隧道映射为飞梭的本地 TCP/HTTP 会话。
- **终端搜索**：`Ctrl+F` 快速搜索 5000 行历史回看。



### 🗄️ DB 手术刀 (轻量 SQL 执行器)

- 专为现场排障设计，支持 **PostgreSQL / MySQL / SQLite**。
- 提供 CodeMirror SQL 高亮、表清单速查、脚本执行、CSV 导出。
- **克制哲学**：只做“查”和“执行”，不做重型 ER 图和建表向导，不替代专业 IDE。



### 🤖 AI 模型测试沙盒

- 独立的 OpenAI 兼容 API 测试页，支持 SSE 流式渲染。
- **严格隔离**：绝不读取你的通讯会话和代码，仅用于纯粹的大模型接口测试。

---



## 🖥️ 界面预览


![启动画面](./docs/images/1.png)
![串口调试](./docs/images/2.png)
![解析协议](./docs/images/3.png)
![websocket](./docs/images/4.png)
![MQTT](./docs/images/5.png)
![SSH](./docs/images/6.png)
![FTP](./docs/images/7.png)
![DB](./docs/images/8.png)
![modbus仿真](./docs/images/9.png)
![网络工具](./docs/images/10.png)

---



## 🛠️ 技术栈


| 层级          | 技术选型                                                          |
| ----------- | ------------------------------------------------------------- |
| **外壳 / 底层** | **Tauri 2.x** (Rust 驱动，极致轻量与安全)                               |
| **前端框架**    | **Vue 3** + Vite + Pinia                                      |
| **UI 组件**   | **Tailwind CSS** + **shadcn-vue** (现代设计语言)                    |
| **网络 / 串口** | `tokio` (异步运行时), `serialport`, `tokio-tungstenite`, `rumqttc` |
| **数据库**     | `sqlx` (纯 Rust 异步 SQL 驱动)                                     |
| **终端渲染**    | `xterm.js` + `xterm-addon-search`                             |


---



## 🚀 快速开始



### 下载与安装

前往 [Releases 页面](#) 下载对应平台的安装包：

- **Windows**: `.msi` 或 `.exe`
- **macOS**: `.dmg` (支持 Intel & Apple Silicon)
- **Linux**: `.AppImage` 或 `.deb`

> **💡 Mac 用户提示**：首次打开若提示“无法验证开发者”，请前往 `系统设置 -> 隐私与安全性` 点击“仍要打开”，或在终端执行 `sudo xattr -rd com.apple.quarantine /Applications/Feisuo.app`。
> **🐧 Linux 用户提示**：若串口无法读取，请将当前用户加入 `dialout` 组：`sudo usermod -a -G dialout $USER`，然后注销重登。



### 键盘流 (Keyboard First)

- `Ctrl/Cmd + K`：唤起全局命令面板（切换会话、跳转工具、执行转换）。
- `Ctrl/Cmd + Enter`：发送消息 / 执行 SQL。
- `Ctrl/Cmd + F`：SSH 终端历史搜索。
- `Ctrl/Cmd + B`：折叠/展开侧边栏。

---



## 👨‍💻 本地开发

如果你想参与贡献或自行编译，请确保已安装 [Node.js (v20+)](https://nodejs.org/)、[pnpm](https://pnpm.io/) 和 [Rust](https://www.rust-lang.org/tools/install)。

```bash
# 1. 克隆仓库
git clone https://github.com/your-username/Feisuo.git
cd Feisuo

# 2. 安装前端依赖
pnpm install

# 3. 启动开发模式 (前端热更新 + Rust 自动重编)
pnpm tauri dev

# 4. 打包生产版本
pnpm tauri build
```

---



## 🚫 明确不做 (Out of Scope)

为了保持工具的**轻量与纯粹**，我们刻意砍掉了以下功能：

- ❌ **不做** 数据波形图 / 示波器（请使用 Serial Studio）。
- ❌ **不做** 重型数据库管理 / ER 图设计（请使用 DBeaver / DataGrip）。
- ❌ **不做** 抓包嗅探 / 改 IP 路由（请使用 Wireshark / 系统命令）。
- ❌ **不做** 团队协作 / 云端同步（数据永远只留在你的本机）。

---



## 🤝 贡献与许可

本项目采用 [MIT License](LICENSE) 开源。
欢迎提交 Issue 报告 Bug，或提交 PR 贡献代码。在提交重大功能 PR 前，请先开 Issue 讨论，以确保符合项目的“克制”哲学。

---

**Feisuo (飞梭)** - 让每一次调试，都如飞梭般轻盈、精准。