import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbeResult, rationalRate } from './media.js';
import { validateAnalysisOutput } from './gemini.js';

test('FFprobe technical metadata applies rotation and exact rational frame rate', () => {
  const result = parseProbeResult({
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
      avg_frame_rate: '30000/1001', duration: '30.03', side_data_list: [{ rotation: -90 }] },
      { codec_type: 'audio', codec_name: 'aac' }],
    format: { format_name: 'mov,mp4', duration: '31' },
  }, 1024);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(result.aspectRatio, '9:16');
  assert.equal(result.orientation, 'portrait');
  assert.equal(result.fps, 30000 / 1001);
  assert.equal(result.durationSeconds, 30.03);
  assert.equal(result.hasAudio, true);
});

test('audio-only and zero-duration uploads are rejected', () => {
  assert.throws(() => parseProbeResult({ streams: [{ codec_type: 'audio' }] }, 100), /playable video/);
  assert.throws(() => parseProbeResult({ streams: [{ codec_type: 'video', width: 100, height: 100, duration: '0', avg_frame_rate: '30/1' }] }, 100), /valid duration/);
  assert.equal(rationalRate('0/0'), undefined);
});

test('cover art is not mistaken for a video stream', () => {
  assert.throws(() => parseProbeResult({ streams: [
    { codec_type: 'video', disposition: { attached_pic: 1 }, width: 500, height: 500, duration: 30, avg_frame_rate: '30/1' },
  ] }, 100), /playable video/);
});

test('analysis timestamps must lie within actual source duration', () => {
  const valid = {
    summary: 'A source description.',
    segments: [{ startSeconds: 0, endSeconds: 10, title: 'Scene', description: 'Visible action.', tags: ['outdoors'] }],
    suggestedClips: [{ startSeconds: 2, endSeconds: 5, title: 'Detail', reason: 'Clear visual.', suggestedUse: 'B-roll' }],
    transcript: [], warnings: [],
  };
  assert.equal(validateAnalysisOutput(valid, 10).segments.length, 1);
  assert.throws(() => validateAnalysisOutput(valid, 9), /outside the source/);
  assert.throws(() => validateAnalysisOutput({ ...valid, segments: [{ ...valid.segments[0], startSeconds: 10 }] }, 10), /outside the source/);
});

test('a model cannot smuggle invalid transcript ranges through shape validation', () => {
  assert.throws(() => validateAnalysisOutput({
    summary: 'Description', segments: [{ startSeconds: 0, endSeconds: 10, title: 'A', description: 'B', tags: [] }],
    suggestedClips: [], transcript: [{ startSeconds: 8, endSeconds: 7, text: 'Words' }], warnings: [],
  }, 10), /outside the source/);
});
