# 米豆（dog）

这是本衍生项目附带的**原创**小狗宠物种类，和默认条目里的「大肥鱼 / 鲸鱼娘」形象无关。大肥鱼形象遵循 CC BY-NC-SA，本种类没有复制或改画该形象。

形象是一只毛茸茸的乳白/奶油色三维小狗：浅棕/金色耳朵、又大又圆的棕色眼睛、棕色鼻子，常常张嘴吐舌微笑。立绘与动画按官方参照图与同一只狗的姿势底板制作，是带毛发质感的精致三维画风，不是平涂线稿、简笔卡通或像素侧视狗。

- 种类 id：`dog`
- 显示名：米豆
- 配置：`dog-config.json`
- 动画目录：`dog-animation/`（透明 VP9 `.webm`，按文件名与配置中的动画名对应）
- 立绘：`dog-character.png`
- 表情包：`dog-memes/`（PNG，文件名对应配置 `memes` 的键；该目录存在时本种类只查这里）
- 预览：`preview.gif`

「待机呼吸」按 24 帧/秒生成，长度 2 秒。循环时每轮首帧只出现一次。

「坐下歪头」和「摇尾巴」用同一张坐姿做局部变形，从正坐开始，动作结束时回到正坐。动画以 24 帧/秒播放，保留原来的约 2.08 秒时长。

待机、转头、抱起、跑跳、刨地、睡姿循环、碎碎念、工作表情和余额动作均按 24 帧/秒生成。小步跑的位移随画框宽度缩放，462 px 画框对应 80 px，以配合片中的步幅。

「伸懒腰」补上了前爪撑地、胸口下沉和回到正坐的中间姿势。「入睡」和「醒来」共用与睡姿循环一致的趴睡帧。这三段均以 24 帧/秒生成，保留原有时长。

安装后，首次启动宿主会把配置、动画、立绘和（若有）`dog-memes/` 复制到 `$DSH_HOME/dsh-pet/pet/`（已有 `dog-config.json` 时不覆盖配置）。若已有配置但还没有 `dog-memes/`，仍会补拷表情包目录；若已有配置缺少 `memes` 字段而包内配置有，则只把该字段合并进去，其它用户字段不动。也可手工复制：

```bash
mkdir -p "$DSH_HOME/dsh-pet/pet"
cp dog-config.json "$DSH_HOME/dsh-pet/pet/"
cp dog-character.png "$DSH_HOME/dsh-pet/pet/"
cp -R dog-animation "$DSH_HOME/dsh-pet/pet/"
cp -R dog-memes "$DSH_HOME/dsh-pet/pet/"
```

重新生成动画需要 Python 3、Pillow、numpy、opencv-python 和带 libvpx-vp9 的 ffmpeg。原始姿势底板放在 `dsh-pet/scripts/dog-source/`。`motion-masters/` 存放原画、道具以及依据米豆原图生成的伸展和睡姿过渡底板。

```bash
python3 scripts/generate-dog-pet.py
```

本种类的代码与配置沿用 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的 MIT 协议与二次创作约定。
