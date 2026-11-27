# 米豆系统内存清理

独立的 Windows 小工具：监视整机物理内存，并按你的设置回收可释放的内存。它不是 DeepSeek Harness 插件的一部分，也不会改动插件里那张「清理内存」卡（那张卡只清语音缓存、未在播放的动画和天气缓存）。

程序带中文设置窗口，配置保存在 `%APPDATA%\mido-ram-cleaner\config.json`。

仓库的 `dist/mido-ram-cleaner.exe` 是带米豆图标的 64 位发布版，可以直接下载使用。图标源文件是本目录的 `icon.ico`（透明多尺寸：16/32/48/64/128/256），托盘图标与文件图标使用同一套。

## 构建

在仓库中的本目录下交叉编译（在 Linux / macOS / Windows 都可以）：

```sh
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w -H windowsgui" -o dist/mido-ram-cleaner.exe .
```

不需要 MinGW，也不需要 CGO。产物是单个 `mido-ram-cleaner.exe`。已提交的 `rsrc_windows_amd64.syso` 会在链接时写入 Windows 应用图标；若要重做图标资源：

```sh
python3 make_icon.py
go-winres simply --arch amd64 --manifest gui --icon icon.ico \
  --product-name "米豆系统内存清理" \
  --file-description "米豆系统内存清理" \
  --original-filename mido-ram-cleaner.exe
```

## 使用

1. 双击 `mido-ram-cleaner.exe`。程序会在本机打开设置窗口（优先用 Edge / Chrome 的应用窗口；否则打开默认浏览器），并在通知区域放一个托盘图标。
2. 窗口里可以看到已用、可用、总共内存和占用百分比，大约每秒刷新一次。
3. 可打开「启用自动清理」，设定：
   - 定时间隔（秒）
   - 占用阈值（已用物理内存百分比，默认 85%）
   - 两次自动清理的最短间隔（秒），避免占用一直偏高时反复清理
4. 「立即清理」会马上执行一次，不受开关限制。
5. 若当前不是管理员，窗口会提供「以管理员身份完整清理一次」。完整清理需要提升权限；拒绝提升时，仍会做不需要管理员也能做的那部分。

同一时间只运行一份。再次打开程序会唤起已有窗口。退出请用托盘菜单里的「退出」，只关浏览器窗口不会结束后台监视。

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
