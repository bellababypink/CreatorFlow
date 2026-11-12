import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MediaMetadata } from '../../shared/types.js';
import { ProcessingError } from './errors.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 4 * 1024 * 1024;

export function mediaBinary(kind: 'ffprobe' | 'ffmpeg'): string {
  return process.env[kind === 'ffprobe' ? 'FFPROBE_PATH' : 'FFMPEG_PATH'] || kind;
}

export async function mediaToolStatus(): Promise<{ ffprobe: boolean; ffmpeg: boolean }> {
  const checks = await Promise.allSettled(
    (['ffprobe', 'ffmpeg'] as const).map((kind) =>
      execFileAsync(mediaBinary(kind), ['-version'], { timeout: 5_000, maxBuffer: MAX_OUTPUT }),
    ),
  );
  return { ffprobe: checks[0].status === 'fulfilled', ffmpeg: checks[1].status === 'fulfilled' };
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function rationalRate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator)) return undefined;
  if (denominator === undefined) return positiveNumber(numerator);
  return positiveNumber(numerator / denominator);
}

function greatestCommonDivisor(a: number, b: number): number {
  return b ? greatestCommonDivisor(b, a % b) : a;
}

/** Parse container metadata, never model timestamps, for technical measurements. */
export function parseProbeResult(probe: unknown, sizeBytes: number): MediaMetadata {
  if (!probe || typeof probe !== 'object') throw new ProcessingError('INVALID_MEDIA', 'The file could not be inspected.');
  const data = probe as { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video' && !(stream.disposition as { attached_pic?: number } | undefined)?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video) throw new ProcessingError('INVALID_MEDIA', 'Upload a video file containing a playable video stream.');
  let width = positiveNumber(video.width);
  let height = positiveNumber(video.height);
  const durationSeconds = positiveNumber(video.duration) ?? positiveNumber(data.format?.duration);
  const fps = rationalRate(video.avg_frame_rate) ?? rationalRate(video.r_frame_rate);
  if (!width || !height || !durationSeconds || !fps) {
    throw new ProcessingError('INVALID_MEDIA', 'The video is missing a valid duration, resolution, or frame rate.');
  }
  if (width > 16_384 || height > 16_384 || width * height > 100_000_000) {
    throw new ProcessingError('UNSUPPORTED_MEDIA', 'The video resolution exceeds the processing limit.');
  }
  const maxDuration = positiveNumber(process.env.MAX_VIDEO_DURATION_SECONDS) ?? 600;
  if (durationSeconds > maxDuration) {
    throw new ProcessingError('DURATION_LIMIT', `Videos must be ${maxDuration} seconds or shorter for this workspace.`);
  }
  const sideData = video.side_data_list as { rotation?: number }[] | undefined;
  const tags = video.tags as { rotate?: string } | undefined;
  const rotation = Number(sideData?.find((item) => item.rotation !== undefined)?.rotation ?? tags?.rotate ?? 0);
  if (Math.abs(rotation % 180) === 90) [width, height] = [height, width];
  const divisor = greatestCommonDivisor(width, height);
  return {
    durationSeconds,
    width,
    height,
    fps,
    aspectRatio: `${width / divisor}:${height / divisor}`,
    orientation: width === height ? 'square' : width > height ? 'landscape' : 'portrait',
    hasAudio: Boolean(audio),
    videoCodec: String(video.codec_name ?? 'unknown'),
    ...(audio ? { audioCodec: String(audio.codec_name ?? 'unknown') } : {}),
    format: String(data.format?.format_name ?? 'unknown'),
    sizeBytes,
  };
}

function subprocessError(error: unknown, kind: 'ffprobe' | 'ffmpeg'): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    throw new ProcessingError('CONFIGURATION_REQUIRED', `${kind} is unavailable. Configure ${kind === 'ffprobe' ? 'FFPROBE_PATH' : 'FFMPEG_PATH'} on the media worker.`);
  }
  if ((error as { killed?: boolean })?.killed) {
    throw new ProcessingError('PROCESSING_TIMEOUT', `${kind} exceeded its processing time limit.`, true);
  }
  throw new ProcessingError('INVALID_MEDIA', `${kind} could not process this video. Try a supported MP4, MOV, or WebM file.`);
}

export async function inspectMedia(filePath: string): Promise<MediaMetadata> {
  const input = path.resolve(filePath);
  await access(input);
  const info = await stat(input);
  if (!info.isFile() || info.size === 0) throw new ProcessingError('INVALID_MEDIA', 'The uploaded video is empty or invalid.');
  let output: string;
  try {
    const result = await execFileAsync(mediaBinary('ffprobe'), [
      '-v', 'error', '-max_alloc', '134217728', '-protocol_whitelist', 'file',
      '-format_whitelist', 'mov,matroska,webm,avi',
      '-show_format', '-show_streams', '-print_format', 'json', input,
    ], { timeout: 30_000, maxBuffer: MAX_OUTPUT, encoding: 'utf8' });
    output = result.stdout;
  } catch (error) {
    subprocessError(error, 'ffprobe');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch {
    throw new ProcessingError('INVALID_MEDIA', 'The video metadata is unreadable.');
  }
  return parseProbeResult(parsed, info.size);
}

export async function createThumbnail(filePath: string, outputPath: string): Promise<void> {
  try {
    await execFileAsync(mediaBinary('ffmpeg'), [
      '-nostdin', '-v', 'error', '-max_alloc', '134217728', '-threads', '1',
      '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi', '-i', path.resolve(filePath),
      '-map', '0:v:0', '-frames:v', '1', '-vf', "scale='min(960,iw)':-2",
      '-threads', '1', '-q:v', '3', '-y', path.resolve(outputPath),
    ], { timeout: 45_000, maxBuffer: MAX_OUTPUT });
  } catch (error) {
    subprocessError(error, 'ffmpeg');
  }
}
