# 安装（dsh-pet-mido / 米豆）

> 这是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的衍生项目。请从 **本仓库的 `dsh-pet/` 插件目录** 构建后，用本地 `file:` 路径装进 DeepSeek Harness。
>
> **不要**执行 `npm install dsh-pet` 或 `npm install -g dsh-pet`，也 **不要**在「插件管理」里只填写包名 `dsh-pet`。那会装到 npm 上的上游官方包，没有本仓库的「米豆」（kind/id：`dog`），也没有下面这些说明。

> 返回 [README](README.md)

装完后请 **完全退出并重新打开** DeepSeek Harness（只关窗口不够；`dsh web` 用户则重启 `dsh web`）。运行中的进程持有内存里的旧插件。宠物默认出现在界面右上角，可在设置页修改。

## 前置要求

命令行安装需要 Node.js 与 DSH 启动器。桌面应用已自带 CLI 时，可跳过全局安装启动器，但仍需 Node.js 来构建本仓库。

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
npm install
npm run build       # 必须手动跑一次（克隆后 npm install 不再自动构建）

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

完全不装 DSH 也能从 **本仓库源码** 跑独立窗口（部分依赖 DSH 的能力不可用，见下）。不要用 `npm install -g dsh-pet` 去装上游包。

```sh
cd dsh-pet
npm install
npm run build
npm run standalone     # Node 形态启动
```

打包成 Windows 解压即用的目录：

```sh
npm run ensure:electron   # 首次：解析或下载本机 Electron
npm run dist              # electron-builder 打包
```

产物在 `dist-app/win-unpacked/`，双击其中的 `dsh-pet.exe`。本仓库不保证提供现成的 Release 绿色包。

### 能力边界

- **能用**：动画链、点击/拖拽/甩抛、右键菜单、多开、自定义动画与表情包、pet pack。
- **不可用**：余额、碎碎念、对话、系统通知——没有 DSH 的凭据与模型连接。
- **配置**：与 DSH 同一份（`$DSH_HOME/dsh-pet/main-config.jsonc` → 包内默认）。
- **只显示** `display` 含 `desktop` / `both` 的实例。
- **可与 DSH 内运行同时开**，但共用 `%APPDATA%\dsh-pet-electron-helper`，可能互相踩缓存（仅告警）。

## 安装后你会看到什么

默认配置是 `display: "both"`（浏览器与桌面都显示），所以重开 DSH 之后会依次出现两处，不必手动开：

1. **浏览器端先出现。** 宠物落在界面右上角（默认角落，设置页可改），此时桌面上还是空的。
2. **宿主自动补桌面运行时。** 本机没有 Electron 时，插件会自己下载一份（落在 `~/.dsh/electron`，同一版本只下一次；默认走 npmmirror 镜像）。进度打在 DSH 控制台里。这一步在后台进行；要等多久取决于网速。
3. **桌面端随后出现。** 解压完自动拉起桌面 Helper，同一只宠物以透明窗形式落到桌面上——此时屏幕上可能一共两只，共用同一份配置与动画。
4. **想只留一只。** 设置页「显示位置」，或宠物右键菜单里的「显示位置」：仅浏览器 / 仅桌面 / 两者都显示 / 都不显示。

本机已有 `~/.dsh/electron`（或设了 `DSH_PET_ELECTRON_PATH`）时，第 2 步会跳过。下载失败只影响桌面模式，浏览器里的宠物不受影响。

## 本衍生版装完之后

1. **米豆（kind: `dog`）**：首次启动会把内置种类写入 `$DSH_HOME/dsh-pet/pet/`。打开设置页的宠物列表，可在「dog / 米豆」这一组里改大小、位置与显示方式。若该目录里已经有 `dog-config.json`，不会覆盖你的改动。
2. **插件「清理内存」**：设置页（或独立模式设置）有「清理内存」卡，默认开启。默认值：`intervalSec` 1800（30 分钟）、`thresholdMb` 512、`debounceSec` 120。可改这些值，也可以点「立即清理」。它清的是语音缓存、未在播放的动画 blob，以及 uapi / 天气缓存；**不会**删除对话记录，也 **不能保证** 整个 DeepSeek Harness 进程占用立刻下降。
3. **对话配图**：米豆的表情包尚未收录，「纳入对话的配图」现在可能是空的。
4. **默认条目**：本仓库不附带原「大肥鱼」动画、立绘、字体或表情包。默认条目要显示原形象，需自行从上游 Release 把素材放到相应目录。只想用米豆时，把默认条目的显示位置设为「都不显示」，或在设置里只保留米豆即可。
5. **系统内存清理**：若要监控整机内存并回收可释放的系统缓存 / 工作集，请使用仓库里的独立工具 [tools/mido-ram-cleaner/](tools/mido-ram-cleaner/README.md)。它不进 pet pack，也不改插件这张「清理内存」卡。

重新生成米豆动画（可选，需 Python 3、Pillow、numpy、带 libvpx-vp9 的 ffmpeg）：

```bash
python3 dsh-pet/scripts/generate-dog-pet.py
```

## 下一步

- 大小、位置、多开、物理参数等配置：见 [CONFIG.md](CONFIG.md)
- 想自己生成一只宠物：见 [MAKE-YOUR-OWN-PET.md](MAKE-YOUR-OWN-PET.md)
