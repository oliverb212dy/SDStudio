import { ComfyUiImageGenService } from '../comfyui';
import { GenerationProviderService } from '../provider';
import type { Config } from '../../../../main/config';
import type { ImageGenInput } from '../../imageGen';
import { Model, Resolution, Sampling, NoiseSchedule } from '../../imageGen';

describe('ComfyUI image generation', () => {
  it('submits the API workflow and downloads the first output image', async () => {
    const workflow = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'old' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'old negative' } },
      '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 1, cfg: 1 } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: 1, height: 1 } },
      '5': { class_type: 'SaveImage', inputs: {} },
    };
    const config: Config = {
      generationProvider: 'comfyui',
      comfyUi: {
        baseUrl: 'http://127.0.0.1:8188',
        workflowJson: JSON.stringify(workflow),
      },
    };
    const service = new ComfyUiImageGenService(async () => config);

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ prompt_id: 'prompt-1' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          'prompt-1': {
            status: { completed: true, status_str: 'success' },
            outputs: {
              '5': {
                images: [{ filename: 'result.png', subfolder: '', type: 'output' }],
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    (global as any).fetch = fetchMock;

    const params: ImageGenInput = {
      model: Model.Anime,
      prompt: 'new prompt',
      uc: 'new negative',
      resolution: { width: 1024, height: 768 },
      sampling: Sampling.KEuler,
      outputFilePath: 'unused',
      steps: 20,
      promptGuidance: 7,
      cfgRescale: 0,
      noiseSchedule: NoiseSchedule.Native,
      vibes: [],
      seed: 123,
    };

    await expect(service.generateImage('', params)).resolves.toBe('AQID');
    const submitted = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(submitted.prompt['1'].inputs.text).toBe('new prompt');
    expect(submitted.prompt['2'].inputs.text).toBe('new negative');
    expect(submitted.prompt['3'].inputs.seed).toBe(123);
    expect(submitted.prompt['3'].inputs.steps).toBe(20);
    expect(submitted.prompt['3'].inputs.cfg).toBe(7);
    expect(submitted.prompt['4'].inputs.width).toBe(1024);
    expect(submitted.prompt['4'].inputs.height).toBe(768);
  });

  it('routes generation to the configured provider', async () => {
    const novelAi = {
      login: jest.fn(),
      generateImage: jest.fn(async () => 'novelai'),
      augmentImage: jest.fn(),
      upscaleImage: jest.fn(),
      getRemainCredits: jest.fn(async () => 10),
      getOpusUsageStatus: jest.fn(),
      encodeVibeImage: jest.fn(),
      validateToken: jest.fn(),
    };
    const comfyUi = {
      login: jest.fn(),
      generateImage: jest.fn(async () => 'comfyui'),
      augmentImage: jest.fn(),
      upscaleImage: jest.fn(),
      getRemainCredits: jest.fn(async () => 0),
      getOpusUsageStatus: jest.fn(),
      encodeVibeImage: jest.fn(),
      validateToken: jest.fn(),
    };
    const service = new GenerationProviderService(
      async () => ({ generationProvider: 'comfyui' }),
      novelAi,
      comfyUi,
    );
    const params = {} as ImageGenInput;

    await expect(service.generateImage('', params)).resolves.toBe('comfyui');
    expect(comfyUi.generateImage).toHaveBeenCalledWith('', params);
    expect(novelAi.generateImage).not.toHaveBeenCalled();
  });
});
