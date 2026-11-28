import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopSync, type DesktopSyncInput } from './sync.ts';

function createHarness(stopHelperAndWait: DesktopSyncInput['stopHelperAndWait'] = async () => {}) {
  const events: string[] = [];
  const sync = createDesktopSync({
    log: { warn: (message) => events.push(message) },
    logDesktopDecision: () => {},
    desktopPetList: () => [],
    stopHelperAndWait: async (reason) => {
      events.push('stop');
      await stopHelperAndWait(reason);
    },
    startHelper: () => events.push('start'),
  });
  return { sync, events };
}

test('several saves in one burst produce one desktop restart', async () => {
  const { sync, events } = createHarness();
  await Promise.all([sync.requestRestart(), sync.requestRestart(), sync.requestRestart()]);
  assert.deepEqual(events, ['stop', 'start']);
});

test('writes during an active restart produce one follow-up restart', async () => {
  let entered!: () => void;
  let release!: () => void;
  const stopping = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { sync, events } = createHarness(async () => {
    entered();
    await stopped;
  });
  const first = sync.requestRestart();
  await stopping;
  const following = [sync.requestRestart(), sync.requestRestart()];
  release();
  await Promise.all([first, ...following]);
  assert.deepEqual(events, ['stop', 'start', 'stop', 'start']);
});

test('local settings saves preserve attached DSH windows', async (t) => {
  const envKeys = ['DSH_PET_IN_PROCESS', 'DSH_PET_DSH_CONNECTED', 'DSH_PET_PETS'] as const;
  const old = envKeys.map((key) => process.env[key]);
  t.after(() => {
    envKeys.forEach((key, index) => {
      if (old[index] === undefined) delete process.env[key];
      else process.env[key] = old[index];
    });
  });
  process.env.DSH_PET_IN_PROCESS = '1';
  process.env.DSH_PET_DSH_CONNECTED = '1';
  process.env.DSH_PET_PETS = '[{"id":"remote","size":180}]';
  const { sync, events } = createHarness();

  await sync.requestRestart();

  assert.equal(process.env.DSH_PET_PETS, '[{"id":"remote","size":180}]');
  assert.deepEqual(events, []);
});
