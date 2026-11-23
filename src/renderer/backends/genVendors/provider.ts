import type { Config } from '../../../main/config';
import type {
  EncodeVibeImageInput,
  ImageAugmentInput,
  ImageGenInput,
  ImageGenService,
  ImageUpscaleInput,
  LoginValidity,
  OpusUsageStatus,
} from '../imageGen';
import type { RecentRequestOptions } from '../../models/requestTiming';

export class GenerationProviderService implements ImageGenService {
  constructor(
    private readonly getConfig: () => Promise<Config>,
    private readonly novelAi: ImageGenService,
    private readonly comfyUi: ImageGenService,
  ) {}

  public invalidateConfigCache(): void {
    this.novelAi.invalidateConfigCache?.();
    this.comfyUi.invalidateConfigCache?.();
  }

  private async provider(): Promise<'novelai' | 'comfyui'> {
    const config = await this.getConfig();
    return config.generationProvider === 'comfyui' ? 'comfyui' : 'novelai';
  }

  async login(email: string, password: string): Promise<{ accessToken: string }> {
    return (await this.provider()) === 'comfyui'
      ? this.comfyUi.login(email, password)
      : this.novelAi.login(email, password);
  }

  async generateImage(token: string, params: ImageGenInput): Promise<string> {
    return (await this.provider()) === 'comfyui'
      ? this.comfyUi.generateImage(token, params)
      : this.novelAi.generateImage(token, params);
  }

  async augmentImage(token: string, params: ImageAugmentInput): Promise<string> {
    return (await this.provider()) === 'comfyui'
      ? this.comfyUi.augmentImage(token, params)
      : this.novelAi.augmentImage(token, params);
  }

  async upscaleImage(token: string, params: ImageUpscaleInput): Promise<string> {
    return (await this.provider()) === 'comfyui'
      ? this.comfyUi.upscaleImage(token, params)
      : this.novelAi.upscaleImage(token, params);
  }

  async getRemainCredits(token: string, options?: RecentRequestOptions): Promise<number> {
    return (await this.provider()) === 'comfyui'
      ? this.comfyUi.getRemainCredits(token, options)
      : this.novelAi.getRemainCredits(token, options);
  }

  async getOpusUsageStatus(token: string, options?: RecentRequestOptions): Promise<OpusUsageStatus> {
    return (await this.provider()) === 'comfyui'
      ? this.comfyUi.getOpusUsageStatus(token, options)
      : this.novelAi.getOpusUsageStatus(token, options);
  }

  async encodeVibeImage(token: string, params: EncodeVibeImageInput): Promise<string> {
    return (await this.provider()) === 'comfyui'
      ? this.comfyUi.encodeVibeImage(token, params)
      : this.novelAi.encodeVibeImage(token, params);
  }

  async validateToken(token: string): Promise<LoginValidity> {
    return (await this.provider()) === 'comfyui'
      ? this.comfyUi.validateToken(token)
      : this.novelAi.validateToken(token);
  }
}
