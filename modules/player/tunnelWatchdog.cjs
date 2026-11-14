// Keep the tunnel tied to its parent's pipe, even if the parent crashes.
// A fixed Node entry point avoids passing configuration to a shell.
const { spawn } = require('node:child_process')

const [file, ...args] = process.argv.slice(2)
const child = spawn(file, args, { shell: false, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
let killTimer
let stopping = false
function stop() {
  if (stopping || child.exitCode !== null || child.signalCode !== null) return
  stopping = true
  child.kill('SIGTERM')
  killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
  killTimer.unref()
}
process.stdin.on('end', stop)
process.stdin.on('error', stop)
process.stdin.resume()
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
child.on('error', (error) => {
  console.error(`cloudflared watchdog: ${error.message}`)
  process.exitCode = 1
})
child.on('close', (code) => {
  clearTimeout(killTimer)
  process.stdin.destroy()
  process.exitCode = code ?? 1
})
