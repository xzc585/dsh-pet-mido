/**
 * 「桌宠配置」面板的草稿与保存：条目切换、实例列表的读入、面板装配与两个写接口。
 *
 * 每个条目保留自己的草稿。点保存后，main 连同全局字段走 PUT /config，其余条目走 POST /pet-config。
 * 单只宠物的字段与增删见 ./pet-card，条目级全局字段见 ./globals。
 * @module dsh-pet/src/standalone/settings-page/script/pets
 */

/** 生成宠物面板片段。 */
export function petsScript(): string {
  return `
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 原配置里的 physics 段，用来判断哪些可选键「本来就有」。 */
let physicsSource = null;
let petBaselines = new Map();

/** 动作频率权重：缺字段或非法项回落到内置默认，三项各自独立判定。 */
function pickWeights(raw) {
  const base = Object.assign({}, FALLBACK_WEIGHTS);
  if (!raw || typeof raw !== 'object') return base;
  for (const key of ['idle', 'turn', 'move']) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value >= 0) base[key] = value;
  }
  return base;
}

/** 长期记忆段：provider 与 powercontext 都齐全才认，否则给空 provider（= 不提交，保留旧值）。 */
function pickMemory(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const conf = source.powercontext && typeof source.powercontext === 'object' ? source.powercontext : {};
  return {
    provider: typeof source.provider === 'string' ? source.provider : '',
    powercontext: {
      endpoint: typeof conf.endpoint === 'string' ? conf.endpoint : '',
      token: typeof conf.token === 'string' ? conf.token : '',
      optimizeQuery: conf.optimizeQuery === true,
    },
  };
}

function pickGlobals(main) {
  const source = main || {};
  const physics = source.physics && typeof source.physics === 'object' ? source.physics : null;
  physicsSource = physics;
  return {
    notificationsEnabled: source.notificationsEnabled !== false,
    // 与 voiceNotifyEnabled 同理：本项默认关，字段缺失时不能显示成已勾选，
    // 否则设置页显示「开」而消费端拿到 undefined 当成「关」，两边打架。
    notifyWhenFocused: source.notifyWhenFocused === true,
    clickSoundEnabled: source.clickSoundEnabled !== false,
    whisperImageEnabled: source.whisperImageEnabled === true,
    chatImageEnabled: source.chatImageEnabled === true,
    chatAnimationEnabled: source.chatAnimationEnabled === true,
    confineToScreen: source.confineToScreen === true,
    trayEnabled: source.trayEnabled !== false,
    voiceEnabled: source.voiceEnabled === true,
    voiceName: typeof source.voiceName === 'string' && source.voiceName ? source.voiceName : DEFAULT_VOICE_ID,
    // 识别实现：独立模式只有内置几家，缺值时留空——空值不提交，服务端保留原值
    speechProvider: typeof source.speechProvider === 'string' ? source.speechProvider : '',
    // 长期记忆：整段读，缺段或空实现都表示「还没配」
    memory: pickMemory(source.memory),
    // 天气城市覆盖：空串是有效值（= 跟随 IP 自动定位），与上面 speechProvider 的空值语义不同，照常提交
    environmentCity: typeof source.environmentCity === 'string' ? source.environmentCity : '',
    voiceVolume: typeof source.voiceVolume === 'number' ? source.voiceVolume : 1,
    voiceWhisperEnabled: source.voiceWhisperEnabled !== false,
    voiceTodoEnabled: source.voiceTodoEnabled !== false,
    // 与 voiceTodo/voiceWhisper 的 !== false 写法不同：本项默认关，字段缺失时不能显示成已勾选，
    // 否则设置页显示「开」而播放端拿到 undefined 当成「关」，两边打架。
    voiceNotifyEnabled: source.voiceNotifyEnabled === true,
    physics: Object.assign({}, FALLBACK_PHYSICS, source.physics || {}),
    font: Object.assign({}, FALLBACK_FONT, source.font || {}),
    chatMemoryRounds: Number.isFinite(Number(source.chatMemoryRounds)) ? Number(source.chatMemoryRounds) : 0,
    chatImageLimit: Number.isFinite(Number(source.chatImageLimit)) ? Number(source.chatImageLimit) : 0,
    animationWeights: pickWeights(source.animationWeights),
    memoryCleanup: pickCleanup(source.memoryCleanup),
  };
}

function initDrafts(config, pending = []) {
  const previousPets = state.pets;
  const previousGlobals = state.globals;
  const previousPhysics = physicsSource;
  state.config = config;
  state.globals = pickGlobals(config.main);
  state.pets = {};
  state.prompts = {};
  for (const key of Object.keys(config)) {
    const conf = config[key];
    if (!conf || !Array.isArray(conf.pets)) continue;
    state.pets[key] = cloneJson(conf.pets);
    if (typeof conf.whisperPrompt === 'string') state.prompts[key] = conf.whisperPrompt;
  }
  if (!state.pets.main) state.pets.main = [];
  petBaselines = new Map(Object.keys(state.pets).map((entry) => [entry, JSON.stringify(petEntryBody(entry))]));
  for (const entry of pending) state.pets[entry] = previousPets[entry];
  if (pending.includes('main')) {
    state.globals = previousGlobals;
    physicsSource = previousPhysics;
  }
  if (!state.pets[state.entry]) state.entry = 'main';
  if (state.petIndex >= currentPets().length) state.petIndex = 0;
}

function currentPets() {
  return state.pets[state.entry] || [];
}

function currentPet() {
  return currentPets()[state.petIndex];
}

function entryTabs(keys) {
  const tabs = keys.map((key) => tabButton(key === 'main' ? '默认条目' : key, key === state.entry, () => {
    state.entry = key;
    state.petIndex = 0;
    renderPetsPanel();
  }));
  return make('div', { class: 'tabs' }, tabs);
}

function packNote() {
  return card('条目说明', null, [
    make('p', { class: 'cardHint', text: '这个条目来自文件宠物，只保存它自己的实例；全局开关与语音外观在「默认条目」里改。' }),
  ]);
}

function renderPetsPanel() {
  const host = byId('pet-cards');
  if (!host) return;
  host.textContent = '';
  const keys = Object.keys(state.pets);
  if (keys.length > 1) host.append(entryTabs(keys));
  host.append(petCard());
  if (state.entry === 'main') {
    for (const builder of globalCards()) host.append(builder());
  } else {
    host.append(packNote());
  }
}

/** 提交用的 physics 段：原配置没写过的可选键不带出去，避免保存时凭空补键。 */
function physicsBody() {
  const out = Object.assign({}, state.globals.physics);
  for (const key of ['tiltGravity', 'shakeThrow', 'hapticEnabled']) {
    if (!physicsSource || !(key in physicsSource)) delete out[key];
  }
  return out;
}

function petsBody() {
  return Object.assign({ pets: state.pets.main }, {
    notificationsEnabled: state.globals.notificationsEnabled,
    notifyWhenFocused: state.globals.notifyWhenFocused,
    clickSoundEnabled: state.globals.clickSoundEnabled,
    whisperImageEnabled: state.globals.whisperImageEnabled,
    chatImageEnabled: state.globals.chatImageEnabled,
    chatAnimationEnabled: state.globals.chatAnimationEnabled,
    confineToScreen: state.globals.confineToScreen,
    trayEnabled: state.globals.trayEnabled,
    voiceEnabled: state.globals.voiceEnabled,
    voiceName: state.globals.voiceName,
    voiceVolume: state.globals.voiceVolume,
    voiceWhisperEnabled: state.globals.voiceWhisperEnabled,
    voiceTodoEnabled: state.globals.voiceTodoEnabled,
    voiceNotifyEnabled: state.globals.voiceNotifyEnabled,
    // 空串 = 还没读到成品值：不提交，免得用一个本地猜的实现覆盖配置
    ...(state.globals.speechProvider ? { speechProvider: state.globals.speechProvider } : {}),
    // 记忆段整段提交；provider 或地址为空 = 还没读到成品值，不提交，免得覆盖配置
    ...(state.globals.memory.provider && state.globals.memory.powercontext.endpoint ? { memory: state.globals.memory } : {}),
    // 城市覆盖与上面不同：空串是有效值（= 恢复自动定位），必须照常提交
    environmentCity: state.globals.environmentCity || '',
    physics: physicsBody(),
    font: state.globals.font,
    chatMemoryRounds: state.globals.chatMemoryRounds,
    chatImageLimit: state.globals.chatImageLimit,
    animationWeights: state.globals.animationWeights,
    memoryCleanup: state.globals.memoryCleanup,
  });
}

function petEntryBody(entry) {
  return entry === 'main' ? petsBody() : { entry, pets: state.pets[entry] };
}

function changedPetEntries() {
  return Object.keys(state.pets).filter((entry) => JSON.stringify(petEntryBody(entry)) !== petBaselines.get(entry));
}

function checkedPetEntry(entry) {
  const body = petEntryBody(entry);
  if (body.pets.length === 0) throw new Error('每个条目至少需要保留一只宠物。');
  const pets = body.pets.map((pet) => {
    const name = '「' + (pet.name || pet.id) + '」';
    if (!Number.isFinite(pet.size) || pet.size < 1) throw new Error(name + '的画框宽度须为不小于 1 的数字。');
    if (pet.sizePercent === undefined) return pet;
    const sizePercent = Number(pet.sizePercent);
    if (!Number.isFinite(sizePercent) || sizePercent < 1) {
      throw new Error(name + '的本体占屏宽度上限须留空或填写不小于 1 的数字。');
    }
    return { ...pet, sizePercent };
  });
  return { ...body, pets };
}

async function savePetEntry(entry, body) {
  if (entry !== 'main') return callApi('POST', '/pet-config', body);
  const merged = await callApi('PUT', '/config', body);
  if (!merged || merged.ok !== false || merged.reason !== 'user-config-unparsable') return merged;
  const file = merged.userFile ? String(merged.userFile) : '用户配置';
  const confirmed = await confirmDialog({
    title: '配置文件无法解析',
    text: file + '\\n继续保存会按白名单重建这个文件，里面其它内容会丢失。',
    confirmLabel: '覆盖保存',
    danger: true,
  });
  if (!confirmed) throw new Error('已取消保存。');
  return callApi('PUT', '/config?force=1', body);
}

async function savePets() {
  const status = byId('pet-status');
  const saveBtn = byId('pet-save');
  const fields = byId('pet-cards');
  const pending = changedPetEntries();
  const entries = pending.length ? pending : [state.entry];
  saveBtn.disabled = true;
  fields.inert = true;
  setStatus(status, '正在保存…');
  let saved = 0;
  try {
    const bodies = entries.map(checkedPetEntry);
    for (let i = 0; i < entries.length; i++) {
      const merged = await savePetEntry(entries[i], bodies[i]);
      if (!merged || merged.ok === false) {
        throw new Error((merged && (merged.message || merged.reason)) || '宿主拒绝了这次保存。');
      }
      saved += 1;
      initDrafts(merged, entries.slice(saved));
    }
    setStatus(status, '已保存到本机。', 'ok');
  } catch (error) {
    const prefix = saved > 0 ? '已保存 ' + saved + ' 个条目。' : '';
    setStatus(status, prefix + (error && error.message ? error.message : String(error)), 'error');
  } finally {
    fields.inert = false;
    saveBtn.disabled = false;
    markDirty(changedPetEntries().length > 0);
    if (saved > 0) renderPetsPanel();
  }
}
`;
}
