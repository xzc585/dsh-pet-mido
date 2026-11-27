/**
 * 设置页「DeepSeek Harness 连接」卡：展示状态并提供手动连接 / 断开。
 * 只在独立入口应用（mido.exe）里有对应接口；CLI 独立模式会显示说明。
 * @module dsh-pet/src/standalone/settings-page/script/dsh-connect
 */

/** 生成连接卡脚本。 */
export function dshConnectScript(): string {
  return `
async function fetchConnect(method, path) {
  const response = await fetch(path, {
    method: method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-DSH-Pet-Token': TOKEN },
  });
  const data = await response.json().catch(() => null);
  if (response.status === 404) {
    throw new Error('请使用桌面上的米豆入口（mido.exe）来连接 DeepSeek Harness。');
  }
  if (!response.ok) {
    throw new Error((data && (data.message || data.error)) || '连接接口暂时无法处理请求');
  }
  return data;
}

function paintConnect(data) {
  const status = byId('dsh-connect-status');
  const foot = byId('dsh-connect-foot');
  const connectBtn = byId('dsh-connect-btn');
  const disconnectBtn = byId('dsh-disconnect-btn');
  if (status) status.textContent = (data && data.message) || '';
  if (foot) foot.textContent = data && data.mode === 'dsh' ? '已连接 DSH' : '独立模式';
  if (connectBtn) {
    connectBtn.hidden = !(data && data.canConnect);
    connectBtn.disabled = !data || !data.canConnect;
  }
  if (disconnectBtn) {
    disconnectBtn.hidden = !(data && data.canDisconnect);
    disconnectBtn.disabled = !data || !data.canDisconnect;
  }
}

async function refreshConnect(resultKind) {
  const result = byId('dsh-connect-result');
  try {
    const data = await fetchConnect('GET', '/mido-control/status');
    paintConnect(data);
    if (result && resultKind !== 'keep') setStatus(result, '', resultKind);
  } catch (error) {
    const message = (error && error.message) || String(error);
    paintConnect({
      mode: 'standalone',
      message: message,
      canConnect: false,
      canDisconnect: false,
    });
    if (result) setStatus(result, message, 'error');
  }
}

function wireDshConnect() {
  const connectBtn = byId('dsh-connect-btn');
  const disconnectBtn = byId('dsh-disconnect-btn');
  const result = byId('dsh-connect-result');
  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      connectBtn.disabled = true;
      try {
        const data = await fetchConnect('POST', '/mido-control/connect');
        if (result) setStatus(result, data.message || '已连接。', data.ok ? 'ok' : 'error');
        await refreshConnect('keep');
      } catch (error) {
        if (result) setStatus(result, (error && error.message) || String(error), 'error');
        connectBtn.disabled = false;
      }
    });
  }
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      disconnectBtn.disabled = true;
      try {
        const data = await fetchConnect('POST', '/mido-control/disconnect');
        if (result) setStatus(result, data.message || '已断开。', data.ok ? 'ok' : 'error');
        await refreshConnect('keep');
      } catch (error) {
        if (result) setStatus(result, (error && error.message) || String(error), 'error');
        disconnectBtn.disabled = false;
      }
    });
  }
  void refreshConnect();
  setInterval(() => {
    void refreshConnect('keep');
  }, 4000);
}
`;
}
