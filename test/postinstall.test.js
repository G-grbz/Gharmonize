import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../scripts/postinstall.cjs', import.meta.url), 'utf8');

for (const platform of ['linux', 'win32']) {
  test(`${platform}: desktop dependency installation invokes Node directly without a command shell`, () => {
    const executable = platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node';
    const cli = platform === 'win32' ? 'C:\\Gharmonize build\\electron-builder\\cli.js' : '/build/electron-builder/cli.js';
    const calls = [];
    const require = name => {
      assert.equal(name, 'node:child_process');
      return { spawnSync: (...args) => { calls.push(args); return { status: 0 }; } };
    };
    require.resolve = name => { assert.equal(name, 'electron-builder/cli.js'); return cli; };
    const context = vm.createContext({ require, console: { log() {}, error() {} },
      process: { platform, execPath: executable, env: { BUILD_ELECTRON: '1' }, exit(code) { throw new Error(`Unexpected exit ${code}`); } } });
    vm.runInContext(source, context);
    assert.equal(calls.length, 1);
    const [command, args, options] = calls[0];
    assert.equal(command, executable);
    assert.deepEqual(Array.from(args), [cli, 'install-app-deps']);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
  });
}
