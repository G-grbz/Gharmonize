import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('master warning follows the selection without disabling or changing the channel', () => {
  const source = fs.readFileSync('public/ui/SettingsManager.js', 'utf8');
  const select = { value: 'stable', disabled: false };
  const warning = { hidden: true };
  const context = vm.createContext({
    document: { getElementById: (id) => id === 'ffmpegMasterWarning' ? warning : select }
  });
  // The UI module's sole import is unrelated to this DOM-only behavior.
  vm.runInContext(source.replace(/^import .*;\s*$/m, '').replace('export class SettingsManager', 'class SettingsManager').replace('export const settingsManager', 'const settingsManager') + '\nglobalThis.manager = settingsManager;', context);
  for (const value of ['stable', 'master', 'stable']) {
    select.value = value;
    context.manager.syncFfmpegChannelWarning();
    assert.equal(warning.hidden, value !== 'master');
    assert.equal(select.value, value);
    assert.equal(select.disabled, false);
  }
  assert.match(source, /addEventListener\('change', \(\) => this\.syncFfmpegChannelWarning\(\)\)/);
  for (const locale of ['tr', 'en', 'de', 'fr', 'es']) {
    const messages = JSON.parse(fs.readFileSync(`public/lang/${locale}.json`, 'utf8'));
    assert.match(messages['settings.ffmpegChannelMasterWarning'], /13\.1/);
  }
});
