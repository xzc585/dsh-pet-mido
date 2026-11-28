/**
 * 「桌宠配置」面板的全局部分：开关、语音、外观、物理、移动端、对话模型与落盘位置。
 *
 * 全部读写 state.globals（main 条目的全局字段），由 ./pets 的保存一并提交。
 * 卡片按 builder 数组返回，渲染时机由 ./pets 决定——这里不自己找容器。
 * @module dsh-pet/src/standalone/settings-page/script/globals
 */

/** 生成全局卡片片段。 */
export function globalsScript(): string {
  return `
function globalCards() {
  return [globalFlagsCard, voiceCard, fontCard, physicsCard, motionCard, modelCard, memoryCard, systemMemoryCard, cleanupCard, environmentCard, advancedCard];
}

function setGlobal(key, value) {
  state.globals[key] = value;
}

function globalFlagsCard() {
  const g = state.globals;
  return card('全局开关', '对所有宠物生效；保存后立即写盘。', [
    toggleRow('g-notify', '系统通知', '对话完成、生成失败、权限申请等事件弹出系统通知。', g.notificationsEnabled, (value) => setGlobal('notificationsEnabled', value)),
    toggleRow('g-notify-focused', '前台聚焦时也提醒', '开着本页、窗口在前台时照样弹通知、照样播报工作状态语音。默认关闭。', g.notifyWhenFocused, (value) => setGlobal('notifyWhenFocused', value)),
    toggleRow('g-click', '点击音效', '点击宠物时播放内置音效。', g.clickSoundEnabled, (value) => setGlobal('clickSoundEnabled', value)),
    toggleRow('g-whisper-image', '碎碎念配图', '碎碎念时允许模型挑一张表情包。', g.whisperImageEnabled, (value) => setGlobal('whisperImageEnabled', value)),
    toggleRow('g-chat-image', '对话配图', '对话时把表情包清单交给模型按语境选图。', g.chatImageEnabled, (value) => setGlobal('chatImageEnabled', value)),
    toggleRow('g-chat-anim', '对话动作联动', '对话时让模型挑一个动作当场表演。', g.chatAnimationEnabled, (value) => setGlobal('chatAnimationEnabled', value)),
    toggleRow('g-confine', '锁定在当前屏幕', '抛掷与自主漫游只在当前所在的这块屏幕里活动。', g.confineToScreen, (value) => setGlobal('confineToScreen', value)),
    toggleRow('g-tray', '系统托盘图标', '桌面模式常驻托盘；关掉后只能从任务栏找回。', g.trayEnabled, (value) => setGlobal('trayEnabled', value)),
  ]);
}


function pickCleanup(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const enabled = source.enabled !== false;
  const intervalSec = Number(source.intervalSec);
  const thresholdMb = Number(source.thresholdMb);
  const debounceSec = Number(source.debounceSec);
  return {
    enabled: enabled,
    intervalSec: Number.isFinite(intervalSec) && intervalSec >= 1 ? intervalSec : FALLBACK_MEMORY_CLEANUP.intervalSec,
    thresholdMb: Number.isFinite(thresholdMb) && thresholdMb >= 1 ? thresholdMb : FALLBACK_MEMORY_CLEANUP.thresholdMb,
    debounceSec: Number.isFinite(debounceSec) && debounceSec >= 1 ? debounceSec : FALLBACK_MEMORY_CLEANUP.debounceSec,
  };
}


function formatRamBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return (Math.round(gb * 10) / 10).toFixed(1).replace(/[.]0$/, '') + ' GB';
  return Math.max(0, Math.round(bytes / (1024 * 1024))) + ' MB';
}

function systemMemoryToggle(input, title, hint) {
  return make('label', { class: 'rowCheck' }, [
    input,
    make('span', { class: 'rowCheckText' }, [
      make('span', { class: 'rowCheckTitle', text: title }),
      make('span', { class: 'rowCheckHint', text: hint }),
    ]),
  ]);
}

function systemMemoryReport(report) {
  const titles = { auto: '自动清理', manual: '手动清理', elevated: '管理员清理' };
  const date = new Date(report.at);
  const time = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const title = '上次' + (titles[report.trigger] || '清理') + (time ? ' · ' + time : '');
  if (report.error) return title + ' · 清理失败 · ' + report.error;
  const before = report.before?.usedBytes;
  const after = report.after?.usedBytes;
  if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < 0) return title + ' · 暂无前后读数';
  const change = before > after ? '已用减少 ' + formatRamBytes(before - after)
    : after > before ? '已用增加 ' + formatRamBytes(after - before) : '已用未下降';
  return title + ' · 已用 ' + formatRamBytes(before) + ' → ' + formatRamBytes(after) + '，' + change
    + (report.standbyCleared ? '（已清空待机列表）' : '');
}

function systemMemoryCard() {
  const health = make('p', { class: 'cardHint', text: '正在连接内存清理帮手…' });
  const usage = make('p', { class: 'cardHint', hidden: true, text: '暂无当前内存占用读数。' });
  const last = make('p', { class: 'cardHint', text: '暂无清理记录。' });
  const status = make('span', { class: 'status', role: 'status' });
  const autoBox = make('input', { type: 'checkbox', id: 'g-sysmem-auto', checked: true });
  const usageBox = make('input', { type: 'checkbox', id: 'g-sysmem-show-usage', checked: true });
  const notifyBox = make('input', { type: 'checkbox', id: 'g-sysmem-notify' });
  const interval = make('input', { type: 'number', id: 'g-sysmem-interval', min: '30', max: '86400', step: '1', value: '1800' });
  const threshold = make('input', { type: 'number', id: 'g-sysmem-threshold', min: '50', max: '99', step: '1', value: '85' });
  const debounce = make('input', { type: 'number', id: 'g-sysmem-debounce', min: '10', step: '1', value: '120' });
  const controls = {
    autoClean: autoBox, showUsage: usageBox, notifyOnClean: notifyBox,
    intervalSec: interval, thresholdPercent: threshold, debounceSec: debounce,
  };
  const nowBtn = button('立即清理', () => { void clean(false); });
  const adminBtn = button('以管理员身份完整清理一次', () => { void clean(true); });
  let current = { autoClean: true, showUsage: true, notifyOnClean: false, intervalSec: 1800, thresholdPercent: 85, debounceSec: 120 };
  let available = false;
  let busy = false;
  let reading = false;
  let revision = 0;

  function syncDisabled() {
    for (const input of [...Object.values(controls), nowBtn, adminBtn]) input.disabled = !available || busy;
  }

  function paintControls() {
    syncDisabled();
    for (const [key, input] of Object.entries(controls)) {
      if (input.type === 'checkbox') input.checked = current[key] === true;
      else if (input !== document.activeElement) input.value = String(current[key]);
    }
    usage.hidden = !health.hidden || !current.showUsage;
  }

  function applySystemMemory(body) {
    available = body?.available === true;
    health.hidden = available && body.ok !== false;
    if (!health.hidden) {
      if (body?.reason === 'not-windows') health.textContent = '系统内存清理只在 Windows 上可用。';
      else if (body?.reason === 'helper-missing') health.textContent = '没有找到系统内存清理帮手，请确认插件目录里有这份工具。';
      else health.textContent = body?.message || '暂时无法连接到系统内存清理帮手。';
    }
    if (available) {
      if (body.config) {
        current = Object.assign({}, body.config, {
          showUsage: body.config.showUsage !== false, notifyOnClean: body.config.notifyOnClean === true,
        });
      }
      if (Number.isFinite(body.usedPercent)) {
        const percent = (Math.round(body.usedPercent * 10) / 10) + '%';
        usage.textContent = '内存占用 ' + percent + ' · 已用 ' + formatRamBytes(body.usedBytes)
          + ' / ' + formatRamBytes(body.totalBytes) + '，可用 ' + formatRamBytes(body.availableBytes);
      }
      if (body.lastClean) last.textContent = systemMemoryReport(body.lastClean);
      if (typeof body.isAdmin === 'boolean') adminBtn.hidden = body.isAdmin;
    }
    paintControls();
  }

  async function submit(path, data, loading, failure, onSuccess) {
    if (!available || busy) return;
    busy = true;
    revision++;
    syncDisabled();
    setStatus(status, loading);
    try {
      const body = await callApi('POST', path, data);
      if (!body?.ok) {
        if (body?.available === false) applySystemMemory(body);
        setStatus(status, body?.message || failure, 'error');
      } else {
        applySystemMemory(body);
        onSuccess(body);
      }
    } catch (error) {
      setStatus(status, error?.message || failure, 'error');
    } finally {
      busy = false;
      paintControls();
    }
  }

  function clean(elevated) {
    const path = elevated ? '/system-memory/clean-elevated' : '/system-memory';
    return submit(path, undefined, elevated ? '正在请求权限…' : '正在清理…', '清理失败，请稍后重试。', (body) => {
      if (elevated && body.message) setStatus(status, body.message, 'ok');
      else if (body.lastClean?.error) setStatus(status, '清理失败 · ' + body.lastClean.error, 'error');
      else if (body.message) setStatus(status, body.message, 'ok');
      else if (body.lastClean) setStatus(status, '清理已完成。', 'ok');
      else setStatus(status, elevated ? '已请求管理员权限。' : '已请求清理。', 'ok');
    });
  }

  function saveConfig(key, input) {
    if (input.type === 'number' && (input.value === '' || !input.checkValidity())) {
      setStatus(status, '请填写说明所列范围内的数值。', 'error');
      return;
    }
    const value = input.type === 'checkbox' ? input.checked : Math.round(Number(input.value));
    const next = Object.assign({}, current, { [key]: value });
    next.debounceSec = Math.min(next.intervalSec, next.debounceSec);
    return submit('/system-memory/config', next, '正在保存…', '设置未能保存。', () => {
      if (current[key] === next[key]) setStatus(status, '已保存。', 'ok');
      else setStatus(status, '帮手未确认该设置。', 'error');
    });
  }

  for (const [key, input] of Object.entries(controls)) {
    input.addEventListener('change', () => { void saveConfig(key, input); });
  }
  const panel = card('系统内存清理', '收缩各进程工作集，管理员清理还可清空待机列表。此处设置改动后立即保存。', [
    health,
    usage,
    last,
    systemMemoryToggle(autoBox, '启用自动清理', '按定时间隔或占用阈值清理。手动清理始终可以使用。'),
    systemMemoryToggle(usageBox, '显示当前内存占用', '在设置卡和桌面米豆旁显示内存占用。'),
    systemMemoryToggle(notifyBox, '清理完成后通知', '由 Windows 系统通知报告清理结果，设置页关闭时也适用。'),
    fieldRow('g-sysmem-interval', '定时间隔（秒）', interval, '从上次清理或帮手启动起算。到点就清一次；若占用先达到阈值，会提前清理。须在 30 到 86400 秒之间。'),
    fieldRow('g-sysmem-threshold', '占用阈值（%）', threshold, '已用物理内存达到该百分比就提前清理。须在 50% 到 99% 之间。'),
    fieldRow('g-sysmem-debounce', '最短间隔（秒）', debounce, '两次自动清理的最短间隔，须不小于 10 秒，且不能大于定时间隔。'),
    make('div', { class: 'row' }, [nowBtn, adminBtn, status]),
  ]);
  paintControls();
  async function refreshSystemMemory() {
    if (!panel.isConnected || busy || reading) return;
    reading = true;
    const started = revision;
    let body;
    try {
      body = await callApi('GET', '/system-memory');
    } catch (error) {
      body = { available: false, message: error?.message };
    }
    reading = false;
    if (started === revision && panel.isConnected) applySystemMemory(body);
  }
  const refreshTimer = setInterval(() => {
    if (panel.isConnected) void refreshSystemMemory();
    else clearInterval(refreshTimer);
  }, 2000);
  void Promise.resolve().then(refreshSystemMemory);
  return panel;
}

function cleanupCard() {
  const g = state.globals;
  if (!g.memoryCleanup) g.memoryCleanup = Object.assign({}, FALLBACK_MEMORY_CLEANUP);
  const status = make('span', { class: 'cardHint', text: '' });
  const btn = button('立即清理', async () => {
    btn.disabled = true;
    status.textContent = '正在清理…';
    try {
      const body = await callApi('POST', '/memory-cleanup');
      const bytes = body && typeof body.freedBytes === 'number' ? body.freedBytes : 0;
      status.textContent = '已清理，大约释放 ' + bytes + ' 字节。这不会删除对话记录。';
    } catch (error) {
      status.textContent = (error && error.message) ? error.message : '清理失败，请稍后重试。';
    } finally {
      btn.disabled = false;
    }
  });
  const patchCleanup = (key, value) => {
    g.memoryCleanup = Object.assign({}, g.memoryCleanup, { [key]: value });
    if (key !== 'enabled' && g.memoryCleanup.debounceSec > g.memoryCleanup.intervalSec) {
      g.memoryCleanup.debounceSec = g.memoryCleanup.intervalSec;
    }
  };
  return card('清理缓存', '释放米豆插件自己的动画缓存、后台视频解码和语音缓存。这不会清理系统内存，也不会删除对话记录。这和上面的「长期记忆」、以及再上面的「系统内存清理」都不是一回事。若要回收整机内存，请用「系统内存清理」。定时与占用阈值谁先到就触发；两次自动清理之间有最短间隔。关掉开关后仍可用「立即清理」。', [
    toggleRow('g-cleanup-enabled', '启用定时清理', '关掉后定时与阈值都不再自动跑；「立即清理」仍然可用。', g.memoryCleanup.enabled, (value) => patchCleanup('enabled', value)),
    numberField('g-cleanup-interval', '定时间隔（秒）', g.memoryCleanup.intervalSec, (value) => patchCleanup('intervalSec', Math.round(clampNumber(value, 1, 86400 * 30, FALLBACK_MEMORY_CLEANUP.intervalSec))), { min: 1, step: 1, hint: '从上次清理或本次进程启动起算。若占用先达到阈值，会提前清理。' }),
    numberField('g-cleanup-threshold', '触发阈值（MB）', g.memoryCleanup.thresholdMb, (value) => patchCleanup('thresholdMb', Math.round(clampNumber(value, 1, 1024 * 1024, FALLBACK_MEMORY_CLEANUP.thresholdMb))), { min: 1, step: 1, hint: '进程堆或本插件缓存（语音文件 / 动画素材）任一达到该值就提前清理。' }),
    numberField('g-cleanup-debounce', '最短间隔（秒）', g.memoryCleanup.debounceSec, (value) => patchCleanup('debounceSec', Math.round(clampNumber(value, 1, g.memoryCleanup.intervalSec, Math.min(FALLBACK_MEMORY_CLEANUP.debounceSec, g.memoryCleanup.intervalSec)))), { min: 1, step: 1, hint: '两次自动清理的最短间隔，必须不超过定时间隔。' }),
    make('div', { class: 'row' }, [btn, status]),
  ]);
}

function environmentCard() {
  const g = state.globals;
  const feedback = make('p', { class: 'fieldHint', text: '', hidden: true });
  const show = (text) => {
    feedback.textContent = text;
    feedback.hidden = false;
  };
  const input = make('input', { type: 'text', id: 'g-env-city', value: g.environmentCity || '' });
  input.placeholder = '留空 = 自动定位';
  input.addEventListener('input', () => {
    setGlobal('environmentCity', input.value);
    markDirty(true);
    feedback.hidden = true;
  });
  // 检测走宿主已有的环境查询（不带 pet = 纯查询，不点亮气泡），把 IP 定位结果回填。
  // 必带 fresh=1：不带就会读到 10 分钟内的缓存定位，用户点了检测却拿到旧城市。
  // 必带 ip=1：不带就会把配置里已填的城市原样回显，检测按钮等于没作用。
  // 回填后不自动保存——用户可能还要改，统一走页面底部的保存。
  const detect = button('检测', () => {
    detect.textContent = '检测中…';
    detect.disabled = true;
    callApi('POST', '/environment?fresh=1&ip=1')
      .then((facts) => {
        if (!facts || typeof facts.city !== 'string' || !facts.city) {
          show('宿主没有返回城市（IP 定位失败），请手动填写。');
          return;
        }
        input.value = facts.city;
        setGlobal('environmentCity', facts.city);
        markDirty(true);
        show('已填入：' + facts.city + '（点保存生效）');
      })
      .catch((error) => show('检测失败：' + (error && error.message ? error.message : String(error))))
      .finally(() => {
        detect.textContent = '检测';
        detect.disabled = false;
      });
  });
  return card('环境与定位', '天气查哪座城市。留空 = 按出口 IP 自动定位；填了城市名就按它查。', [
    fieldRow('g-env-city', '城市', make('div', { class: 'row' }, [input, detect]), '填城市名即可，「扬州」和「扬州市」都行。'),
    feedback,
  ]);
}

function voiceCard() {
  const g = state.globals;
  // 运行时目录优先：宿主注册了 Edge / DeepSeek 就都列出来；拉不到回落构建期的内置清单
  const voices = state.voiceOptions && state.voiceOptions.length > 0
    ? state.voiceOptions
    : VOICES.map((voice) => ({ id: voice.id, name: voice.name, tag: voice.tag, provider: voice.provider }));
  const speechProviders = state.speechProviders || [];
  return card('语音', '四类语音各一个开关，互不从属；音色、识别实现与音量共用。', [
    toggleRow('g-voice', '手动播报', '右键菜单与斜杠命令触发的碎碎念、对话回复念出来。', g.voiceEnabled, (value) => setGlobal('voiceEnabled', value)),
    selectField('g-voice-name', '音色', g.voiceName, voices.map((voice) => ({ value: voice.id, label: voice.name + (voice.tag ? ' · ' + voice.tag : ''), group: voice.provider })), (value) => setGlobal('voiceName', value)),
    numberField('g-voice-volume', '音量（0–1）', g.voiceVolume, (value) => setGlobal('voiceVolume', clampNumber(value, 0, 1, 1)), { min: 0, max: 1, step: 0.05 }),
    toggleRow('g-voice-whisper', '周期碎碎念也念出来', '定时生成的那句碎碎念念出来。', g.voiceWhisperEnabled, (value) => setGlobal('voiceWhisperEnabled', value)),
    toggleRow('g-voice-todo', '待办提醒也念出来', '到点的待办提醒念出来。', g.voiceTodoEnabled, (value) => setGlobal('voiceTodoEnabled', value)),
    toggleRow('g-voice-notify', '通知播报', '任务完成、出错、等你确认时念一句配置的工作状态文案；页面被藏起来也照样念。', g.voiceNotifyEnabled, (value) => setGlobal('voiceNotifyEnabled', value)),
    selectField('g-speech-provider', '语音识别', g.speechProvider, speechProviders.map((item) => ({ value: item.id, label: item.name })), (value) => setGlobal('speechProvider', value), '按住录音后交给哪个实现转写。装了对应插件才会出现多个选项；选中的实现不可用时识别会明确报错，不会自动换一个。'),
  ]);
}

function fontCard() {
  const g = state.globals;
  return card('外观与字体', '气泡、悬浮提示与对话窗共用的字体。', [
    selectField('g-font-family', '字体', g.font.family, FONT_IDS.map((id) => ({ value: id, label: id })), (value) => { g.font = Object.assign({}, g.font, { family: value }); }),
    numberField('g-font-size', '字号（px）', g.font.size, (value) => { g.font = Object.assign({}, g.font, { size: clampNumber(value, 4, 200, 21) }); }, { min: 4, max: 200, step: 1, hint: '只影响气泡与悬浮提示，对话窗字号不变。' }),
    toggleRow('g-font-follow', '字号随宠物大小缩放', '关掉后恒为上面的字号，不随窗口尺寸变化。', g.font.followPet, (value) => { g.font = Object.assign({}, g.font, { followPet: value }); }),
  ]);
}

function physicsCard() {
  const g = state.globals;
  return card('拖拽与抛掷手感', '所有宠物共用；数值改动保存后生效。', [
    make('div', { class: 'grid2' }, [
      numberField('g-gravity', '重力加速度（px/s²）', g.physics.gravity, (value) => { g.physics = Object.assign({}, g.physics, { gravity: clampNumber(value, 0, 10000, 1400) }); }, { min: 0, max: 10000, step: 10 }),
      numberField('g-restitution', '碰壁弹性（0–1）', g.physics.restitution, (value) => { g.physics = Object.assign({}, g.physics, { restitution: clampNumber(value, 0, 1, 0.78) }); }, { min: 0, max: 1, step: 0.01 }),
    ]),
    make('div', { class: 'grid2' }, [
      numberField('g-friction', '接触面摩擦（/s）', g.physics.groundFriction, (value) => { g.physics = Object.assign({}, g.physics, { groundFriction: clampNumber(value, 0, 30, 2.5) }); }, { min: 0, max: 30, step: 0.1 }),
      numberField('g-power', '总力度', g.physics.throwPower, (value) => { g.physics = Object.assign({}, g.physics, { throwPower: clampNumber(value, 0.1, 5, 1) }); }, { min: 0.1, max: 5, step: 0.1 }),
    ]),
    toggleRow('g-ceiling', '顶部反弹', '关掉后上方没有边界，抛掷可以飞出屏幕顶部。', g.physics.ceilingBounce !== false, (value) => { g.physics = Object.assign({}, g.physics, { ceilingBounce: value }); }),
    toggleRow('g-collide', '宠物互相碰撞', '飞行中的宠物撞到其它宠物时按动量弹开。', g.physics.petCollision !== false, (value) => { g.physics = Object.assign({}, g.physics, { petCollision: value }); }),
    toggleRow('g-spring', '弹簧跟手', '开（默认）= 拖拽时用弹簧追指针，有一点延迟、手感柔和；关 = 刚性实时跟随，宠物直接贴住鼠标。不影响甩出力度。', g.physics.dragSpring !== false, (value) => { g.physics = Object.assign({}, g.physics, { dragSpring: value }); }),
  ]);
}

function motionCard() {
  const g = state.globals;
  const weights = g.animationWeights;
  const actionId = 'g-motion-action';
  const actionValue = () => String(Math.max(0, 100 - weights.idle - weights.turn - weights.move));
  const syncAction = () => {
    const node = byId(actionId);
    if (node) node.value = actionValue();
  };
  const weightField = (key, label) =>
    numberField('g-motion-' + key, label, weights[key], (value) => {
      const others = weights.idle + weights.turn + weights.move - weights[key];
      const max = Math.max(0, 100 - others);
      weights[key] = Math.round(Math.min(Math.max(value, 0), max));
      syncAction();
    }, { min: 0, max: 100, step: 1 });
  return card('动作频率', '四个框：待机 / 转向 / 移动可改，随机动作自动算（= 100 − 其余三项）。所有宠物共用；pet pack 可在自己种类文件里覆盖。', [
    make('div', { class: 'grid2' }, [
      weightField('idle', '待机（%）'),
      weightField('turn', '转向（%）'),
      weightField('move', '移动（%）'),
      numberField(actionId, '随机动作（%，自动）', actionValue(), () => {}, { min: 0, max: 100, step: 1, readOnly: true }),
    ]),
  ]);
}

function modelCard() {
  const g = state.globals;
  return card('对话上下文', '模型与接入方式在「AI 服务商」页配置；这里管对话保留多少上下文。', [
    make('div', { class: 'grid2' }, [
      numberField('g-memory', '对话记忆轮数', g.chatMemoryRounds, (value) => setGlobal('chatMemoryRounds', Math.round(clampNumber(value, 0, 100, 0))), { min: 0, max: 100, step: 1, hint: '0 表示不带历史。' }),
      numberField('g-image-limit', '配图张数上限', g.chatImageLimit, (value) => setGlobal('chatImageLimit', Math.round(clampNumber(value, 0, 50, 0))), { min: 0, max: 50, step: 1, hint: '0 表示不限制。' }),
    ]),
  ]);
}

function memoryCard() {
  const g = state.globals;
  const memoryProviders = state.memoryProviders || [];
  const isPowerContext = g.memory.provider === POWERCONTEXT_ID;
  // PowerContext 的参数只属于它：选中别家时整块隐藏。用 hidden 切换而不是整卡重渲染——
  // 重渲染会把正在输入的光标位置丢掉。
  const details = make('div', { class: 'grid2', hidden: !isPowerContext }, [
    textField('g-pc-endpoint', 'PowerContext 地址', g.memory.powercontext.endpoint, (value) => {
      g.memory.powercontext = Object.assign({}, g.memory.powercontext, { endpoint: value });
    }, { hint: '本机 PowerContext 服务的根地址，例如 http://127.0.0.1:8000。' }),
    textField('g-pc-token', '访问令牌', g.memory.powercontext.token, (value) => {
      g.memory.powercontext = Object.assign({}, g.memory.powercontext, { token: value });
    }, { secret: true, hint: '服务端没开认证时留空。令牌只存在本机配置里，不进日志。' }),
  ]);
  const optimize = make('div', { hidden: !isPowerContext }, [
    toggleRow('g-pc-optimize', '查询优化', '开启后用模型把这句话改写成检索查询，并带上最近两轮还原指代。默认关闭：指代通常指向刚说过的话，那些轮次本来就在对话历史里。', g.memory.powercontext.optimizeQuery, (value) => {
      g.memory.powercontext = Object.assign({}, g.memory.powercontext, { optimizeQuery: value });
    }),
  ]);
  return card('长期记忆', '对话时用哪个记忆实现；下面的地址、令牌与开关只属于 PowerContext。', [
    selectField('g-memory-provider', '记忆实现', g.memory.provider, memoryProviders.map((item) => ({ value: item.id, label: item.name })), (value) => {
      g.memory.provider = value;
      const show = value === POWERCONTEXT_ID;
      details.hidden = !show;
      optimize.hidden = !show;
    }, '对话时用哪个记忆实现。内置的只带最近若干轮历史；装了第三方记忆插件才会出现更多选项，找不到对应实现时回落内置。'),
    details,
    optimize,
  ]);
}

function pathRows() {
  const meta = state.meta || {};
  const rows = [];
  const pairs = [['用户配置', meta.user], ['内置默认', meta.default], ['动画配置', meta.animations], ['表情包', meta.memes], ['待办数据', meta.todos], ['日志', meta.logs]];
  for (const pair of pairs) {
    if (!pair[1]) continue;
    rows.push(make('div', { class: 'pathRow' }, [
      make('span', { class: 'pathKey', text: pair[0] }),
      make('span', { class: 'pathValue', text: String(pair[1]), title: String(pair[1]) }),
    ]));
  }
  if (Array.isArray(meta.storage)) {
    for (const item of meta.storage) {
      if (!item || !item.path) continue;
      rows.push(make('div', { class: 'pathRow' }, [
        make('span', { class: 'pathKey', text: item.exists === false ? '未生成' : '已存在' }),
        make('span', { class: 'pathValue', text: String(item.path), title: String(item.path) }),
      ]));
    }
  }
  return rows.length ? rows : [make('p', { class: 'empty', text: '读不到落盘位置信息。' })];
}

function advancedCard() {
  return card('高级', '手改配置文件时可以从这里找到位置；「同步」会用内置默认覆盖用户配置。', [
    make('div', {}, pathRows()),
    make('div', { class: 'testRow' }, [button('用内置默认覆盖用户配置', syncFromDefault)]),
  ]);
}

async function syncFromDefault() {
  const confirmed = await confirmDialog({
    title: '用内置默认覆盖用户配置',
    text: '现有的用户配置会被整份替换，这个操作不能撤销。',
    confirmLabel: '覆盖',
    danger: true,
  });
  if (!confirmed) return;
  const status = byId('pet-status');
  setStatus(status, '正在同步…');
  try {
    const merged = await callApi('POST', '/config');
    initDrafts(merged);
    markDirty(false);
    renderPetsPanel();
    setStatus(status, '已用内置默认覆盖用户配置。', 'ok');
  } catch (error) {
    setStatus(status, error && error.message ? error.message : String(error), 'error');
  }
}
`;
}
