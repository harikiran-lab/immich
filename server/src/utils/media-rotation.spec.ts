import { defaults } from 'src/dtos/config.dto.js';
import { ColorTransfer, TranscodeHardwareAcceleration, TranscodeTarget } from 'src/enum.js';
import { BaseConfig } from 'src/utils/media.js';
import { videoInfoStub } from 'test/fixtures/media.stub.js';

const makeConfig = (targetResolution = 'original', accelDecode = true) =>
  BaseConfig.create(
    { ...defaults.ffmpeg, accel: TranscodeHardwareAcceleration.Nvenc, accelDecode, targetResolution },
    { dri: [], mali: false },
  );
const makeVideo = (rotation: number, width = 1920, height = 1080) => ({
  ...videoInfoStub.videoStreamHDR.videoStreams[0],
  width,
  height,
  rotation,
  colorTransfer: ColorTransfer.AribStdB67,
});

describe('NVDEC rotation', () => {
  it.each([
    [-90, 'clock'],
    [90, 'cclock'],
    [180, 'reversal'],
    [-180, 'reversal'],
    [270, 'clock'],
    [-270, 'cclock'],
  ] as const)('bakes %s degree rotation after tone mapping', (rotation, direction) => {
    const command = makeConfig().getCommand(TranscodeTarget.Video, makeVideo(rotation));
    expect(command.inputOptions.slice(-2)).toEqual(['-display_rotation', '0']);
    const filter = command.outputOptions[command.outputOptions.indexOf('-vf') + 1];
    expect(filter).toContain('tonemap_cuda=');
    expect(filter).toContain(`:format=nv12,transpose_cuda=dir=${direction}`);
    expect(filter).not.toContain(`transpose_cuda=dir=${direction}:format`);
  });

  it.each([
    [1920, 1080, '-2:720'],
    [1080, 1920, '720:-2'],
  ] as const)('scales stored %sx%s before rotating', (width, height, scaling) => {
    const command = makeConfig('720').getCommand(TranscodeTarget.Video, makeVideo(-90, width, height));
    expect(command.outputOptions).toContainEqual(
      expect.stringMatching(new RegExp(`^scale_cuda=${scaling},tonemap_cuda=.*transpose_cuda=dir=clock$`)),
    );
  });

  it('leaves unrotated video unchanged', () => {
    const command = makeConfig().getCommand(TranscodeTarget.Video, makeVideo(0));
    expect(command.inputOptions).not.toContain('-display_rotation');
    expect(command.outputOptions.join(' ')).not.toContain('transpose_cuda');
  });

  it('retains the source matrix when video is copied', () => {
    const command = makeConfig().getCommand(TranscodeTarget.Audio, makeVideo(-90));
    expect(command.inputOptions).not.toContain('-display_rotation');
    expect(command.outputOptions).not.toContain('-vf');
    expect(command.outputOptions[command.outputOptions.indexOf('-c:v') + 1]).toBe('copy');
  });

  it('rotates SDR even when scaling and tone mapping are unnecessary', () => {
    const video = { ...makeVideo(-90), colorTransfer: ColorTransfer.Bt709, pixelFormat: 'yuv420p' };
    const command = makeConfig().getCommand(TranscodeTarget.Video, video);
    expect(command.outputOptions[command.outputOptions.indexOf('-vf') + 1]).toBe('transpose_cuda=dir=clock');
  });

  it('keeps software decoding on FFmpeg autorotation', () => {
    const command = makeConfig('original', false).getCommand(TranscodeTarget.Video, makeVideo(-90));
    expect(command.inputOptions).not.toContain('-noautorotate');
    expect(command.inputOptions).not.toContain('-display_rotation');
    expect(command.outputOptions.join(' ')).not.toContain('transpose_cuda');
  });

  it('also rotates HLS frames and clears their source matrix', () => {
    const command = makeConfig().getHlsCommand(
      {
        inputPath: 'input.mp4',
        initFilename: 'init.mp4',
        playlistFilename: 'index.m3u8',
        segmentFilename: 'segment-%d.m4s',
        packetCount: 300,
        totalDuration: 10,
        timeBase: 1,
        segmentDuration: 2,
        startSegment: 0,
        target: TranscodeTarget.Video,
      },
      makeVideo(-90),
    );
    expect(command.slice(0, 2)).toEqual(['-display_rotation', '0']);
    expect(command[command.indexOf('-vf') + 1]).toContain(',transpose_cuda=dir=clock');
  });
});
