# Temporary-directory cleanup adapter

This package replaces only `temp@0.9.4`'s `rimraf@~2.6.2` dependency through an
npm override. Squirrel's electron-winstaller uses temp to create build working
directories. Temp calls the callback-based cleanup function and its `.sync`
method with literal generated paths and `maxBusyTries: 6`.

The adapter implements those calls with Node's built-in `fs.rm`/`fs.rmSync`,
including missing-path tolerance and retry handling. No glob pattern is
expanded, no shell is invoked, and symlinks are removed without following their
targets. There are no third-party dependencies. It is a build dependency and
does not ship inside the Electron application archive.

This is deliberately not a complete rimraf compatibility layer. Keep the
override scoped to the inspected temp version. Remove it when that upstream
dependency migrates to a maintained cleanup API. Do not rename its package or
version to impersonate a patched upstream release.

The repository's `.npmrc` sets `install-links=true`, so npm installs the local
adapter as an ordinary package instead of a development symlink. Keep that
setting and this directory available during `npm ci`, including Docker's
dependency installation layer.
