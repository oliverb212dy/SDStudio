import { Buffer } from 'buffer';
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
import type {
  NaiRequestOptions,
  RecentRequestOptions,
} from '../../models/requestTiming';

type ComfyNode = {
  class_type?: string;
  inputs?: Record<string, unknown>;
};

type ComfyWorkflow = Record<string, ComfyNode>;

function normalizeBaseUrl(value?: string): string {
  const trimmed = (value || 'http://127.0.0.1:8188').trim();
  return trimmed.replace(/\/+$/, '');
}

function withTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortedByCaller = false;

  const abortCaller = () => {
    abortedByCaller = true;
    controller.abort();
  };
  signal?.addEventListener('abort', abortCaller);
  timer = setTimeout(() => controller.abort(), timeoutMs);

  return run(controller.signal).finally(() => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abortCaller);
  }).catch((error) => {
    if (abortedByCaller) throw error;
    if (controller.signal.aborted) throw new Error(`ComfyUI 응답 제한 시간(${timeoutMs / 1000}초)을 초과했습니다`);
    throw error;
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64');
}

function parseWorkflow(raw?: string): ComfyWorkflow {
  if (!raw?.trim()) {
    throw new Error('ComfyUI API 워크플로우 JSON을 설정해주세요');
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ComfyUI 워크플로우 JSON 형식이 올바르지 않습니다');
  }
  if (parsed?.prompt && typeof parsed.prompt === 'object') parsed = parsed.prompt;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ComfyUI API Format의 prompt 객체가 필요합니다');
  }
  if (Array.isArray(parsed.nodes) || parsed.version !== undefined) {
    throw new Error('UI workflow가 아닌 ComfyUI의 「Save (API Format)」 JSON을 사용해주세요');
  }
  return JSON.parse(JSON.stringify(parsed));
}

function findNodes(workflow: ComfyWorkflow, classType: string): string[] {
  return Object.keys(workflow).filter(
    (id) => workflow[id]?.class_type === classType,
  );
}

function setNodeInput(
  workflow: ComfyWorkflow,
  nodeId: string | undefined,
  inputName: string,
  value: unknown,
): void {
  if (!nodeId) return;
  const node = workflow[nodeId];
  if (!node?.inputs) node && (node.inputs = {});
  if (node?.inputs) node.inputs[inputName] = value;
}

function firstConfiguredNode(
  workflow: ComfyWorkflow,
  configuredId: string | undefined,
  classTypes: string[],
): string | undefined {
  if (configuredId && workflow[configuredId]) return configuredId;
  for (const classType of classTypes) {
    const ids = findNodes(workflow, classType);
    if (ids.length > 0) return ids[0];
  }
  return undefined;
}

export class ComfyUiImageGenService implements ImageGenService {
  constructor(private readonly getConfig: () => Promise<Config>) {}

  private async config(): Promise<{ baseUrl: string; workflowJson?: string; comfy: NonNullable<Config['comfyUi']> }> {
    const config = await this.getConfig();
    const comfy = config.comfyUi ?? {};
    return { baseUrl: normalizeBaseUrl(comfy.baseUrl), workflowJson: comfy.workflowJson, comfy };
  }

  public invalidateConfigCache(): void {}

  async login(_email: string, _password: string): Promise<{ accessToken: string }> {
    const valid = await this.validateToken('');
    if (valid !== 'valid') throw new Error('ComfyUI 서버에 연결할 수 없습니다');
    return { accessToken: '' };
  }

  async validateToken(_token: string): Promise<LoginValidity> {
    try {
      const { baseUrl } = await this.config();
      const response = await fetch(`${baseUrl}/system_stats`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (response.ok) return 'valid';
      if (response.status === 401 || response.status === 403) return 'invalid';
      return 'error';
    } catch {
      return 'error';
    }
  }

  async generateImage(_authorization: string, params: ImageGenInput): Promise<string> {
    const { baseUrl, workflowJson, comfy } = await this.config();
    const workflow = parseWorkflow(workflowJson);
    const seed = params.seed ?? Math.floor(Math.random() * 0x100000000);

    const promptNodes = [
      comfy.promptNodeId,
      firstConfiguredNode(workflow, undefined, ['CLIPTextEncode']),
    ].filter((id): id is string => !!id);
    const promptNodeId = promptNodes.find((id) => !!workflow[id]);
    if (promptNodeId) setNodeInput(workflow, promptNodeId, 'text', params.prompt);

    const textNodes = findNodes(workflow, 'CLIPTextEncode');
    const negativeNodeId =
      comfy.negativeNodeId ||
      (textNodes.length > 1 ? textNodes[1] : textNodes.find((id) => id !== promptNodeId));
    if (negativeNodeId) setNodeInput(workflow, negativeNodeId, 'text', params.uc);

    const seedNodeId = firstConfiguredNode(workflow, comfy.seedNodeId, ['KSampler', 'KSamplerAdvanced']);
    setNodeInput(workflow, seedNodeId, 'seed', seed);
    setNodeInput(workflow, seedNodeId, 'noise_seed', seed);

    const stepsNodeId = firstConfiguredNode(workflow, comfy.stepsNodeId, ['KSampler', 'KSamplerAdvanced']);
    setNodeInput(workflow, stepsNodeId, 'steps', params.steps);

    const cfgNodeId = firstConfiguredNode(workflow, comfy.cfgNodeId, ['KSampler', 'KSamplerAdvanced']);
    setNodeInput(workflow, cfgNodeId, 'cfg', params.promptGuidance);

    const widthNodeId = firstConfiguredNode(workflow, comfy.widthNodeId, ['EmptyLatentImage', 'LatentFromBatch']);
    setNodeInput(workflow, widthNodeId, 'width', params.resolution.width);
    const heightNodeId = firstConfiguredNode(workflow, comfy.heightNodeId, ['EmptyLatentImage', 'LatentFromBatch']);
    setNodeInput(workflow, heightNodeId, 'height', params.resolution.height);

    if (params.image) {
      const uploaded = await this.uploadImage(baseUrl, params.image, params.request);
      const imageNodeId = firstConfiguredNode(workflow, comfy.imageNodeId, ['LoadImage']);
      setNodeInput(workflow, imageNodeId, 'image', uploaded);
    }
    if (params.mask) {
      const uploaded = await this.uploadImage(baseUrl, params.mask, params.request, 'mask.png');
      const maskNodeId = firstConfiguredNode(workflow, comfy.maskNodeId, ['LoadImageMask']);
      setNodeInput(workflow, maskNodeId, 'image', uploaded);
    }

    return await withTimeout(
      params.request?.timeoutMs ?? 300_000,
      params.request?.signal,
      async (signal) => {
        const response = await fetch(`${baseUrl}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ prompt: workflow, client_id: `sdstudio-${Date.now()}` }),
          signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`ComfyUI 요청 실패 (${response.status})${detail ? `: ${detail}` : ''}`);
        }
        const submitted = await response.json();
        const promptId = submitted.prompt_id;
        if (!promptId) throw new Error(submitted.error?.message || 'ComfyUI가 prompt_id를 반환하지 않았습니다');

        while (true) {
          if (signal.aborted) throw new Error('ComfyUI 요청이 취소되었습니다');
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const historyResponse = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
            headers: { Accept: 'application/json' },
            signal,
          });
          if (!historyResponse.ok) {
            throw new Error(`ComfyUI 이력 조회 실패 (${historyResponse.status})`);
          }
          const history = await historyResponse.json();
          const record = history?.[promptId];
          if (!record) continue;
          if (record.status?.status_str === 'error') {
            const messages = record.status?.messages?.map((item: any) => JSON.stringify(item)).join('\n');
            throw new Error(`ComfyUI 실행 오류${messages ? `:\n${messages}` : ''}`);
          }
          if (record.status?.completed !== true && record.status?.status_str !== 'success') continue;

          const images = this.collectOutputImages(record.outputs);
          if (images.length === 0) throw new Error('ComfyUI 출력 이미지가 없습니다');
          const image = images[0];
          const viewUrl =
            `${baseUrl}/view?filename=${encodeURIComponent(image.filename)}` +
            `&subfolder=${encodeURIComponent(image.subfolder || '')}` +
            `&type=${encodeURIComponent(image.type || 'output')}`;
          const imageResponse = await fetch(viewUrl, { signal });
          if (!imageResponse.ok) {
            throw new Error(`ComfyUI 이미지 다운로드 실패 (${imageResponse.status})`);
          }
          return arrayBufferToBase64(await imageResponse.arrayBuffer());
        }
      },
    );
  }

  private collectOutputImages(outputs: any): { filename: string; subfolder?: string; type?: string }[] {
    const result: { filename: string; subfolder?: string; type?: string }[] = [];
    if (!outputs || typeof outputs !== 'object') return result;
    for (const output of Object.values(outputs)) {
      if (!output || typeof output !== 'object') continue;
      const images = (output as any).images;
      if (Array.isArray(images)) {
        for (const image of images) {
          if (typeof image?.filename === 'string') result.push(image);
        }
      }
    }
    return result;
  }

  private async uploadImage(
    baseUrl: string,
    image: string,
    options: NaiRequestOptions | undefined,
    filename = 'sdstudio-input.png',
  ): Promise<string> {
    const comma = image.indexOf(',');
    const base64 = comma >= 0 ? image.slice(comma + 1) : image;
    const decoded = Buffer.from(base64, 'base64');
    const bytes = Uint8Array.from(decoded);
    const blob = new Blob([bytes], { type: 'image/png' });
    const form = new FormData();
    form.append('image', blob, filename);
    form.append('overwrite', 'true');
    return await withTimeout(
      options?.timeoutMs ?? 60_000,
      options?.signal,
      async (signal) => {
        const response = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form, signal });
        if (!response.ok) throw new Error(`ComfyUI 이미지 업로드 실패 (${response.status})`);
        const uploaded = await response.json();
        if (!uploaded.name) throw new Error('ComfyUI 이미지 업로드 응답에 이름이 없습니다');
        return uploaded.subfolder
          ? `${uploaded.subfolder}/${uploaded.name}`
          : uploaded.name;
      },
    );
  }

  async augmentImage(_token: string, _params: ImageAugmentInput): Promise<string> {
    throw new Error('현재 ComfyUI 연동에서는 증강 작업을 지원하지 않습니다');
  }

  async upscaleImage(_token: string, _params: ImageUpscaleInput): Promise<string> {
    throw new Error('현재 ComfyUI 연동에서는 업스케일 작업을 지원하지 않습니다');
  }

  async getRemainCredits(_token: string, _options?: RecentRequestOptions): Promise<number> {
    return 0;
  }

  async getOpusUsageStatus(_token: string, _options?: RecentRequestOptions): Promise<OpusUsageStatus> {
    return { opusSubscribed: false, percent: 0, purchasedPercent: 0, isNegative: false, timeUntilNextPercent: 0 };
  }

  async encodeVibeImage(_token: string, _params: EncodeVibeImageInput): Promise<string> {
    throw new Error('현재 ComfyUI 연동에서는 Vibe 인코딩을 지원하지 않습니다');
  }
}
