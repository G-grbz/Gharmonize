import { spawn } from "child_process";
import fs from "fs";

export async function probeMediaFile(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ]);

    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code === 0) {
        try {
          const probeData = JSON.parse(stdout);
          resolve(probeData);
        } catch (parseError) {
          reject(new Error(`FFprobe çıktısı parse edilemedi: ${parseError.message}`));
        }
      } else {
        reject(new Error(`FFprobe hatası (kod ${code}): ${stderr}`));
      }
    });

    ffprobe.on('error', (error) => {
      reject(new Error(`FFprobe başlatılamadı: ${error.message}`));
    });
  });
}

export function parseStreams(probeData) {
  const streams = probeData.streams || [];
  const audioStreams = [];
  const subtitleStreams = [];
  const videoStreams = [];

  streams.forEach((stream, index) => {
    const streamInfo = {
      index: index,
      codec: stream.codec_name,
      codec_long: stream.codec_long_name,
      language: stream.tags?.language || 'und',
      title: stream.tags?.title || '',
      channels: stream.channels,
      sample_rate: stream.sample_rate,
      bit_rate: stream.bit_rate,
      duration: stream.duration,
      default: stream.disposition?.default === 1,
      forced: stream.disposition?.forced === 1
    };

    switch (stream.codec_type) {
      case 'audio':
        audioStreams.push(streamInfo);
        break;
      case 'subtitle':
        subtitleStreams.push(streamInfo);
        break;
      case 'video':
        videoStreams.push(streamInfo);
        break;
    }
  });

  return {
    audio: audioStreams,
    subtitle: subtitleStreams,
    video: videoStreams,
    format: probeData.format || {}
  };
}

export function getDefaultStreamSelection(streams) {
  const selectedAudio = streams.audio.find(stream => stream.default) ||
                       streams.audio[0] ||
                       null;

  const selectedSubtitles = streams.subtitle
    .filter(stream => stream.default || stream.forced)
    .map(stream => stream.index);

  return {
    audio: selectedAudio ? [selectedAudio.index] : [],
    subtitles: selectedSubtitles
  };
}
