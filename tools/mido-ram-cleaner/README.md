# 米豆系统内存清理

Windows 后台帮手：监视整机物理内存，并按你在宠物设置里的选项回收可释放的内存。

日常用法不是双击这个 exe，也不是再开一个设置弹窗，而是：

1. 右键桌面上的米豆。
2. 桌面版点「打开软件」，在 DeepSeek Harness 里打开设置，进入「桌宠配置」。
3. 独立模式则点「打开 AI 设置」。
4. 在「系统内存清理」卡里查看当前占用，开关自动清理，设定定时间隔、占用阈值和最短间隔，或点「立即清理」。

插件会自动找到并拉起这份帮手（优先用插件目录里的 `dsh-pet/assets/tools/mido-ram-cleaner.exe`，完整仓库里也可以用本目录的 `dist/mido-ram-cleaner.exe`）。默认无窗口、无托盘，不把这件事做成另外一个软件。

它和设置页里的「清理缓存」不是一回事。那张卡只清语音缓存、未在播放的动画和天气缓存，不会去清系统内存。

配置保存在 `%APPDATA%\mido-ram-cleaner\config.json`。

仓库的 `dist/mido-ram-cleaner.exe` 与插件 `dsh-pet/assets/tools/mido-ram-cleaner.exe` 是同一份带米豆图标的 64 位发布版。图标源文件是本目录的 `icon.ico`（透明多尺寸：16/32/48/64/128/256）。若仍要调试旧的设置窗，可在命令行加上 `--ui`；日常使用不需要。

## 构建

在仓库中的本目录下交叉编译（在 Linux / macOS / Windows 都可以）：

```sh
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w -H windowsgui" -o dist/mido-ram-cleaner.exe .
```

发布前请把同一份 exe 再拷到 `dsh-pet/assets/tools/mido-ram-cleaner.exe`，这样只安装插件目录的拷贝也能被自动拉起。

不需要 MinGW，也不需要 CGO。产物是单个 `mido-ram-cleaner.exe`。已提交的 `rsrc_windows_amd64.syso` 会在链接时写入 Windows 应用图标；若要重做图标资源：

```sh
python3 make_icon.py
go-winres simply --arch amd64 --manifest gui --icon icon.ico \
  --product-name "米豆系统内存清理" \
  --file-description "米豆系统内存清理" \
  --original-filename mido-ram-cleaner.exe
```

## 本机 HTTP API

帮手启动后只监听 `127.0.0.1:17341`。插件通过这些接口读写配置、查询占用并触发清理：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 探活 |
| GET | `/api/status` | 当前已用 / 可用 / 总共内存、是否管理员、当前配置、上次清理 |
| POST | `/api/config` | 写入自动清理设置（`autoClean`、`intervalSec`、`thresholdPercent`、`debounceSec`） |
| POST | `/api/clean` | 立即清理一次（不需要管理员） |
| POST | `/api/clean-elevated` | 请求管理员权限后做一次完整清理 |
| POST | `/api/quit` | 退出帮手 |

插件对外再包一层，供设置页调用（同源，不必直接打 17341）：`GET/POST /system-memory`、`POST /system-memory/config`、`POST /system-memory/clean-elevated`。

设置页可看到已用、可用、总共内存和占用百分比，大约每两秒刷新一次。可打开「启用自动清理」，设定：

- 定时间隔（秒，30–86400）
- 占用阈值（已用物理内存百分比，默认 85%）
- 两次自动清理的最短间隔（秒），避免占用一直偏高时反复清理

「立即清理」会马上执行一次，不受开关限制。若当前不是管理员，还可以「以管理员身份完整清理一次」。完整清理需要提升权限；拒绝提升时，仍会做不需要管理员也能做的那部分。

同一时间只运行一份。再次启动默认不会弹出窗口。退出由插件在卸载时请求，或调用 `/api/quit`。

## 它会做什么、不会做什么

会做的：

- **始终尝试**收缩各进程的工作集（`EmptyWorkingSet` / `MemoryEmptyWorkingSets`），不结束、不关闭、不强制退出任何程序。对没有权限的进程会跳过。
- **在管理员权限下**，还会清空 Windows 待机列表（`NtSetSystemInformation` 的 `MemoryPurgeStandbyList` / `MemoryPurgeLowPriorityStandbyList`）。这需要相应特权；程序会先尝试开启它们。

不会做的：

- 不会结束其他应用程序，也不会以「释放内存」为名去关进程。
- 不能保证电脑因此更流畅。

## 请先读完的限制

- 收缩工作集、清空待机列表，通常只是把任务管理器里的占用数字压下去。刚用过的页面和文件还可能再从磁盘读回来，短时间内占用也可能回升。
- 清空待机列表需要管理员权限，期间可能出现短暂卡顿。
- 没有管理员权限时，只能清理当前账户有权触达的工作集，系统缓存不会被完整清空。
- 本工具只支持 Windows（建议 64 位）。它不是系统优化广告，也替代不了关闭不用的程序或增加物理内存。
