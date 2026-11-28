import { coreScript } from '../../src/standalone/settings-page/script/core.ts';
import { globalsScript } from '../../src/standalone/settings-page/script/globals.ts';
import { widgetsScript } from '../../src/standalone/settings-page/script/widgets.ts';
import { settingsStyle } from '../../src/standalone/settings-page/style.ts';

const style = document.createElement('style');
style.textContent = settingsStyle;
document.head.append(style);
const script = document.createElement('script');
script.textContent = [
  coreScript('/dsh-pet-7340', {
    voices: [],
    displays: [],
    corners: [],
    fonts: [],
    physics: {},
    font: {},
    weights: {},
    defaultVoice: '',
    powerContextProviderId: 'pc',
  }),
  widgetsScript(),
  globalsScript(),
  'document.body.append(systemMemoryCard());',
].join('\n');
document.body.append(script);
