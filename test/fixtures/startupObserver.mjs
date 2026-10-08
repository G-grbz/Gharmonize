import net from 'node:net';
import assert from 'node:assert/strict';
import path from 'node:path';

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once('listening', async () => {
    try {
      const expected = process.env.GHARMONIZE_TEST_EXPECTED_DATA_DIR;
      const location = await (await fetch(`http://127.0.0.1:${this.address().port}/api/outputs/location`)).json();
      assert.equal(location.outputDir, path.join(expected, 'outputs'));
      assert.equal(location.displayDir, location.outputDir);
      assert.equal(process.env.DATA_DIR, expected);
      this.closeAllConnections?.();
      this.close(() => { console.log('STARTUP_PATHS_OK'); process.exit(0); });
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });
  return originalListen.apply(this, args);
};
