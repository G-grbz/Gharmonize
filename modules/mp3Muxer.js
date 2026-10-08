// Xing/Info stores the frame count, duration and seek table. Without it,
// players may estimate a VBR file's duration from an unrepresentative bitrate.
// A legacy opt-out is safe only when we are explicitly encoding constant bitrate.
export function mp3DurationHeaderArgs({ vbr = true, force = false, env = process.env } = {}) {
  const enabled = vbr || force || env.MP3_WRITE_XING !== "0";
  return ["-write_xing", enabled ? "1" : "0"];
}
