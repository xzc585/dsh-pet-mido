# dsh-pet-mido（米豆）

本仓库是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的衍生项目，不是上游官方仓库。代码沿用 MIT 许可，并遵守上游的二次创作约定（公开说明须附上该地址）。完整归属见 [NOTICE.md](NOTICE.md)，许可条文见 [LICENSE](LICENSE)。

衍生内容主要是一只桌面宠物 **「米豆」**：毛茸茸的三维奶油色 / 浅金毛小狗，浅棕耳朵、圆棕色眼睛、棕色鼻子。种类 id 为 `dog`，显示名为「米豆」。它不是平涂简笔卡通，也不是像素侧视狗。

请从 **本仓库** 安装，不要去装 npm 上的官方包 `dsh-pet`，也不要在插件管理里只填写包名 `dsh-pet`——那会装到上游版本，没有米豆这套形象。

## 安装（请按这里做）

在 DeepSeek Harness 的桌面 profile 中，从本仓库的插件目录安装：

```sh
git clone https://github.com/xzc585/dsh-pet-mido.git
cd dsh-pet-mido/dsh-pet
npm install
npm run build
dsh plugin --profile desktop add file:"$(pwd)"
```

Windows（PowerShell）示例：

```powershell
git clone https://github.com/xzc585/dsh-pet-mido.git
cd dsh-pet-mido\dsh-pet
npm install
npm run build
dsh plugin --profile desktop add file:C:\path\to\dsh-pet-mido\dsh-pet
```

若你用的是 `dsh web`（浏览器），把 `--profile desktop` 改成 `--profile web`。`file:` 必须指向上面这个 **插件目录** `dsh-pet/`（里面有构建好的 `lib/`），不是仓库根目录。

装完后请完全退出并重新打开 DeepSeek Harness（只关窗口不够）。更完整的前置要求、独立模式和装完会看到什么，见 [INSTALL.md](INSTALL.md)。

不要执行 `npm install dsh-pet`、`npm install -g dsh-pet`，也不要在「插件管理」里只填包名 `dsh-pet`。

## 插件里的「清理缓存」

插件设置页已有「清理缓存」（原先叫「清理内存」），默认是开着的。它清的是插件自己的素材缓存，不是系统内存。配置写在用户层 `main-config.jsonc` 顶层的 `memoryCleanup`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后定时与阈值都不再自动跑；「立即清理」仍可用 |
| `intervalSec` | `1800` | 定时间隔（秒） |
| `thresholdMb` | `512` | 占用阈值（MB）。进程堆或本插件缓存任一达到就提前清理 |
| `debounceSec` | `120` | 两次自动清理的最短间隔（秒） |

它会清掉语音缓存、当前没有在播的动画 blob，以及 uapi / 天气缓存。它 **不会** 删除对话记录或改长期记忆，也 **不能保证** 整个 DeepSeek Harness 进程的占用（RSS）立刻降下去。

若要监视并回收 **整机系统内存**，请用下面的「系统内存清理」：右键米豆，打开宠物设置即可调节，不必再单独运行一个软件。

## 对话配图

米豆的对话配图 / 表情包尚未收录。因此设置或菜单里的「纳入对话的配图」现在可能是空的。这不是安装失败。上游「大肥鱼」那套表情包默认也不附带在本仓库中。

## 系统内存清理（Windows）

右键桌面上的米豆，点「打开软件」，在 DeepSeek Harness 里打开设置，进入「桌宠配置」，即可看到「系统内存清理」。独立模式则是右键米豆 →「打开 AI 设置」，同一张卡。

在这张卡里可以查看当前整机已用 / 可用 / 总共内存，打开或关闭自动清理，设定定时间隔、占用阈值和最短间隔，也可以立刻清一次。改动会立刻生效，不必点页面底部的「保存」。这和上面的「清理缓存」不是一回事。

真正干活的是无窗口后台帮手 `mido-ram-cleaner.exe`（仓库里在 `tools/mido-ram-cleaner/dist/`，插件会从 `dsh-pet/assets/tools/` 自动拉起）。它会回收 **可释放** 的内存（收缩进程工作集；管理员权限下还可清空待机列表），不会结束其他程序，也不会自动弹出设置窗口或托盘图标。配置保存在 `%APPDATA%\mido-ram-cleaner\config.json`。

构建、API 与能力边界见 [tools/mido-ram-cleaner/README.md](tools/mido-ram-cleaner/README.md)。简要构建：

```sh
cd tools/mido-ram-cleaner
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w -H windowsgui" -o dist/mido-ram-cleaner.exe .
```

说明：清空工作集或待机列表通常只是把占用数字压下去，刚用过的页面还可能再读盘，不一定更流畅。

## 插件功能

只做桌宠本身，不碰 DSH 内核。米豆有自己的动画池（待机、转头、拖拽/被抱起、点击、移动、日常、玩耍、睡觉起止循环、余额和工作状态档等），配置与素材在 [dsh-pet/assets/pet-packs/dog/](dsh-pet/assets/pet-packs/dog/README.md)，首次启动会写入 `$DSH_HOME/dsh-pet/pet/`（已有 `dog-config.json` 时不覆盖）。

此外仍具备上游插件的能力：多开与自定义种类、浏览器 overlay / 桌面透明窗 / 独立模式、点击与拖拽物理、碎碎念与对话、语音、余额、天气、工作状态联动、待办、睡觉、系统通知与右键菜单等。详情见 [FEATURES.md](FEATURES.md)，配置见 [CONFIG.md](CONFIG.md)。

预览：

<p>
  <img src="dsh-pet/assets/pet-packs/dog/preview.gif" width="240" alt="米豆预览" title="米豆（dog）">
</p>

## 对外接口

- [API.md](API.md) —— HTTP 接口
- [openapi.yaml](openapi.yaml) —— OpenAPI 3.1 契约
- [CORDIS-API.md](CORDIS-API.md) / [CORDIS.md](CORDIS.md) —— 页面内 Cordis 服务
- [tools/api-tester.html](tools/api-tester.html)、[tools/cordis-probe](tools/cordis-probe/README.md) —— 调试示例

## 兼容性

Windows / Linux / macOS 均可运行（浏览器 overlay 与桌面 Electron 透明窗）。浏览器 overlay 兼容 Chromium（Chrome / Edge）与 Firefox 的 VP9-alpha webm；不支持 Safari 的 webm 透明。无图形会话时会跳过桌面窗口。本仓库不附带上游的 Safari/HEVC 素材包。

## 从零生成自己的宠物

AI 提示词 → 绿幕视频 → 透明动画 → 插件。步骤见 [MAKE-YOUR-OWN-PET.md](MAKE-YOUR-OWN-PET.md)。重新生成米豆动画（可选，需 Python 3、Pillow、numpy，以及带 libvpx-vp9 的 ffmpeg）：

```bash
python3 dsh-pet/scripts/generate-dog-pet.py
```

## 项目结构

```
├── README.md  INSTALL.md  FEATURES.md  CONFIG.md  API.md  CORDIS.md  NOTICE.md  LICENSE
├── prompts/           # 动画生成提示词
├── tools/             # 开发工具，以及 mido-ram-cleaner（系统内存清理）
├── dsh-pet/           # 插件本体（在此目录 npm install && npm run build）
│   ├── src/
│   ├── lib/            # 构建产物（不入库，需 npm run build）
│   ├── runtime/        # 桌面模式运行壳
│   └── assets/pet-packs/dog/  # 米豆（kind: dog）
└── LICENSE             # MIT（衍生自上游，见 NOTICE.md）
```

## 许可

本仓库是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的衍生项目，完整归属见 [NOTICE.md](NOTICE.md)。上游与本仓库新增代码均为 MIT；二次创作须附上原作者仓库地址：<https://github.com/PC2005-cloud/dsh-pet>。本仓库不附带原「大肥鱼」形象素材。

问题与建议请到本仓库提 issue：<https://github.com/xzc585/dsh-pet-mido/issues>。
