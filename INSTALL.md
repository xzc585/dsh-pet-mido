# 安装（dsh-pet-mido / 米豆）

> 这是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的衍生项目。请从 **本仓库的 `dsh-pet/` 插件目录** 构建后，用本地 `file:` 路径装进 DeepSeek Harness。
>
> **不要**执行 `npm install dsh-pet` 或 `npm install -g dsh-pet`，也 **不要**在「插件管理」里只填写包名 `dsh-pet`。那会装到 npm 上的上游官方包，没有本仓库的「米豆」（kind/id：`dog`），也没有下面这些说明。

> 返回 [README](README.md)

装完后请 **完全退出并重新打开** DeepSeek Harness（只关窗口不够；`dsh web` 用户则重启 `dsh web`）。运行中的进程持有内存里的旧插件。宠物默认出现在界面右上角，可在设置页修改。

## 前置要求

从源码安装需要 Node.js 22.12 或更新版本。插件模式需要 DSH 启动器。桌面应用已自带 CLI 时，可跳过全局安装启动器。

```sh
node -v
npm install -g @deepseek-ai/dsh pnpm   # 已装可跳过；装完请重新打开终端
dsh --version
```

## 从本仓库安装（推荐，也是正确做法）

`lib/` 构建产物不入库，clone 后必须先在插件目录里安装依赖并构建，再用 `file:` 路径交给 DSH：

```sh
# ① clone 本仓库，进入插件目录（注意是 dsh-pet-mido/dsh-pet）
git clone https://github.com/xzc585/dsh-pet-mido.git
cd dsh-pet-mido/dsh-pet

# ② 安装依赖并构建（完整 lib：tsdown → lib + 桌面共享核心 + 类型声明）
npm ci
npm run build

# ③ 按你在用的界面安装
#    桌面应用（Electron 版）
dsh plugin --profile desktop add file:"$(pwd)"
#    或 dsh web（浏览器）
# dsh plugin --profile web add file:"$(pwd)"
```

Windows 要把 `file:` 写成绝对路径，例如：

```powershell
dsh plugin --profile desktop add file:C:\Users\你的用户名\dsh-pet-mido\dsh-pet
```

`file:` 必须指向 **插件目录**（上面 `cd` 进去、含 `package.json` 与构建好的 `lib/` 的那一层），不是仓库根目录。

若桌面应用的「插件管理」支持填写本地路径，请填这个已构建的插件目录，而不是只填包名 `dsh-pet`。

> 注：`npm run build`（即 `scripts/prepare.js`）才产出完整可安装的 lib。裸 `tsdown` 构建会缺桌面运行时与类型。

> **兼容性**：本插件当前在 dsh **`0.2.2-rc.1`** 下开发并测试（`dsh --version` 可查看你的版本）。建议使用相同版本。

## 独立模式（无需 DSH）

Windows 可使用本仓库的发行 ZIP。完整解压后双击里面的 `dsh-pet.exe`，素材和 Electron 都在同一目录。也可以从源码启动独立窗口。

```sh
cd dsh-pet
npm ci
npm run build
npm run standalone     # Node 形态启动
```

打包成 Windows 解压即用的目录：

```sh
npm run ensure:electron   # 首次：解析或下载本机 Electron
npm run dist              # electron-builder 打包
```

产物在 `dist-app/win-unpacked/`，双击其中的 `dsh-pet.exe`。分发时保留整个解包目录。

轻量入口 `tools/mido/dist/mido.exe` 复用构建好的插件和本机 Electron。插件目录不在启动器的默认查找位置时，在仓库根目录运行以下 PowerShell 命令：

```powershell
$env:MIDO_PET_ROOT = (Resolve-Path .\dsh-pet).Path
.\tools\mido\dist\mido.exe
```

启动前请先构建插件并准备 Electron。打开 DeepSeek Harness（desktop 配置）后，同一只米豆会自动连接；也可以右键「连接 DeepSeek Harness」。详见 [启动器说明](tools/mido/README.md)。

### 能力边界

- **能用**：动画链、点击/拖拽/甩抛、右键菜单、多开、自定义动画与表情包、pet pack。
- **模型能力**：在独立设置页填写模型、接口地址和 API Key 后可聊天及触发碎碎念。余额查询取决于所选服务商。DSH 任务状态和会话通知需要连接 DSH。
- **配置**：与 DSH 同一份（`$DSH_HOME/dsh-pet/main-config.jsonc` → 包内默认）。
- **只显示** `display` 含 `desktop` / `both` 的实例。
- **与 DSH 的关系**：独立入口在桌面上时，插件不会再拉起第二只桌面宠物，而是把聊天、任务状态、配图等宿主能力接到这只已有的米豆上。没有现成官方 attach API，连接走的是本仓库的本机发现协议（见 `dsh-pet/src/shared/mido-attach.ts`）。

## 安装后你会看到什么

米豆默认在浏览器与桌面都显示。重开 DSH 后会依次出现在两处：

1. **浏览器端先出现。** 宠物落在界面右上角（默认角落，设置页可改），此时桌面上还是空的。
2. **宿主自动补桌面运行时。** 本机没有 Electron 时，插件会自己下载一份（落在 `~/.dsh/electron`，同一版本只下一次；默认走 npmmirror 镜像）。进度打在 DSH 控制台里。这一步在后台进行；要等多久取决于网速。
3. **桌面端随后出现。** 解压完自动拉起桌面 Helper，同一只宠物以透明窗形式落到桌面上——此时屏幕上可能一共两只，共用同一份配置与动画。
4. **想只留一只。** 设置页「显示位置」，或宠物右键菜单里的「显示位置」：仅浏览器 / 仅桌面 / 两者都显示 / 都不显示。

本机已有 `~/.dsh/electron`（或设了 `DSH_PET_ELECTRON_PATH`）时，第 2 步会跳过。下载失败只影响桌面模式，浏览器里的宠物不受影响。

## 本衍生版装完之后

1. **米豆（kind: `dog`）**：首次启动会把内置种类写入 `$DSH_HOME/dsh-pet/pet/`。打开设置页的宠物列表，可在「dog / 米豆」这一组里改大小、位置与显示方式。若该目录里已经有 `dog-config.json`，不会覆盖你的改动。
2. **插件「清理缓存」**：设置页（或独立模式设置）有「清理缓存」卡，默认开启。默认值：`intervalSec` 1800（30 分钟）、`thresholdMb` 512、`debounceSec` 120。可改这些值，也可以点「立即清理」。它清的是语音缓存、未在播放的动画 blob，以及 uapi / 天气缓存；**不会**清理系统内存，**不会**删除对话记录，也 **不能保证** 整个 DeepSeek Harness 进程占用立刻下降。
3. **对话配图**：米豆内置 18 张表情图，可在设置中启用对话配图。
4. **上游形象**：默认条目已隐藏。需要使用「大肥鱼」时，从上游获取素材并放到相应目录，再在设置里启用该条目。已有自定义显示配置继续生效。
5. **系统内存清理**：右键米豆 →「打开软件」→ 设置 →「桌宠配置」里的「系统内存清理」（独立模式是右键 →「打开 AI 设置」）。可查看整机占用、开关自动清理、改间隔和阈值，或立刻清一次。插件会自动拉起无窗口帮手，不必再双击桌面上的独立 exe。细节见 [tools/mido-ram-cleaner/README.md](tools/mido-ram-cleaner/README.md)。

重新生成米豆动画（可选，需 Python 3、Pillow、numpy、带 libvpx-vp9 的 ffmpeg）：

```bash
python3 dsh-pet/scripts/generate-dog-pet.py
```

## 下一步

- 大小、位置、多开、物理参数等配置：见 [CONFIG.md](CONFIG.md)
- 想自己生成一只宠物：见 [MAKE-YOUR-OWN-PET.md](MAKE-YOUR-OWN-PET.md)
