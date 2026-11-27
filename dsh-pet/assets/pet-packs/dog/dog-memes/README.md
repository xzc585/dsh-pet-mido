# 米豆表情包（dog-memes）

对话和碎碎念配图用的 PNG 放在这里。文件名（不含 `.png`）必须和 `dog-config.json` 顶层 `memes` 映射的键一致；值为给模型看的中文描述。只有磁盘上真实存在的 `<名称>.png` 且描述非空才会进入候选池。

安装后，宿主会把本目录复制到 `$DSH_HOME/dsh-pet/pet/dog-memes/`：

- 首次写入该种类时，若包内有本目录则一并复制；
- 若用户目录里已有 `dog-config.json`（或 `.jsonc`）但还没有 `dog-memes/`，仍会补拷本目录；
- 不覆盖已有的配置文件，也不覆盖已经存在的 `dog-memes/`。

本目录专属于米豆。只要 `$DSH_HOME/dsh-pet/pet/dog-memes/` 存在，米豆就只查这里，不会回落到用户 `memes/` 或包内默认条目的 `assets/memes`（大肥鱼表情包）。不要把那些图复制进来。

在正式的 PNG 入库之前，不要往 `dog-config.json` 里写空的 `memes` 字段（空键本来也不会进池）。清单提案另行维护，配图到位后再把对应键写进配置。
