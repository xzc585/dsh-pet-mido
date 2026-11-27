# 米豆入口（mido.exe）

双击即可把米豆放到桌面上，不必先启动 DeepSeek Harness（DSH）。这是桌宠入口，不是内存清理工具，也不再弹一个单独的设置窗。

系统内存清理仍然在宠物设置里调节；本程序会复用插件已经拉起的无窗口帮手 `mido-ram-cleaner.exe`。

## 怎么用

1. 把本目录构建出的 `mido.exe` 放到桌面（不要覆盖 `mido-ram-cleaner.exe`）。
2. 保留桌面上的 `dsh-pet` 插件目录（里面要有构建好的 `lib/app.js`、`runtime/` 和米豆动画资源）。本程序默认复用这份插件，不会再复制一套容易不同步的素材包。
3. 桌面运行时（Electron）通常已由插件准备好，位于 `%USERPROFILE%\.dsh\electron\electron.exe`。如果还没有，请先打开一次 DeepSeek Harness（desktop 配置），或设置 `DSH_PET_ELECTRON_PATH`。
4. 双击 `mido.exe`。桌面上会出现透明窗口里的米豆，可以走动、待机，右键打开设置（含系统内存清理）。
5. 之后再打开 DeepSeek Harness（desktop 配置）时，同一只米豆会自动连接宿主，使用聊天、任务状态和配图等能力。连不上时，右键或托盘里选择「连接 DeepSeek Harness」，设置页「配置」里也有同一张卡。失败会给出中文说明，不会静默失败。
6. 不要同时开两只米豆：插件发现独立入口已在运行时，不会再拉起自己的桌面 Helper。连上后是同一只宠物接上宿主，而不是再变出一只。

退出请用托盘里的「退出」，或右键菜单在已连接时先「断开 DeepSeek Harness」（断开后米豆仍留在桌面上独立运行）。

## 和插件目录的关系

| 路径 | 作用 |
| --- | --- |
| 桌面上的 `mido.exe` | 入口，只负责找到插件和 Electron 并拉起 |
| `C:\Users\<你>\Desktop\dsh-pet` | 已安装的插件（动画、设置、连接逻辑都在这里） |
| `%USERPROFILE%\.dsh\electron` | 桌面运行时 |
| `%USERPROFILE%\.dsh\dsh-pet\mido-standalone.json` | 独立入口的本机发现记录 |
| `%USERPROFILE%\.dsh\dsh-pet\mido-dsh-host.json` | DSH 内插件的本机发现记录（不含 DSH 登录令牌） |

也可以用环境变量：

- `MIDO_PET_ROOT`：插件目录（含 `lib/app.js`）
- `DSH_PET_ELECTRON_PATH`：`electron.exe` 的完整路径
- `DSH_HOME`：默认是 `%USERPROFILE%\.dsh`

## 构建

```sh
cd tools/mido
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w -H windowsgui" -o dist/mido.exe .
```

已提交的 `rsrc_windows_amd64.syso` 会写入米豆图标。若要重做：

```sh
go-winres simply --arch amd64 --manifest gui --icon icon.ico   --product-name "米豆"   --file-description "米豆桌宠入口"   --original-filename mido.exe
```

图标源文件与系统内存清理帮手相同，都是本仓库的米豆图标。
