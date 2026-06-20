/**
 * Speech-to-text client.
 *
 * Single implementation that targets any OpenAI-compatible STT endpoint:
 *   - OpenAI Whisper                — https://api.openai.com/v1
 *   - 火山引擎方舟 (推荐)            — https://ark.cn-beijing.volces.com/api/v3
 *   - 阿里云 DashScope               — https://dashscope.aliyuncs.com/compatible-mode/v1
 *   - any other compatible endpoint
 *
 * All providers above accept multipart/form-data POST to
 *   {endpoint}/audio/transcriptions
 * with at minimum `file` and `model` fields and return a JSON body with a
 * `text` field. Language hint and response_format are also widely
 * supported. We standardise on response_format=json so we can parse
 * uniformly regardless of provider.
 *
 * The client uses Obsidian's `requestUrl` helper, which bypasses the
 * standard CORS restrictions that browser `fetch` would impose for
 * cross-origin uploads to external STT APIs.
 */

import { requestUrl } from 'obsidian';

import type { JournalPartnerSettings } from '../section';

export interface STTOptions {
  /** Recording mime type, used to pick a sensible filename. */
  mimeType: string;
  /** File extension matching the mime (no leading dot). */
  ext: string;
}

export class STTConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'STTConfigError';
  }
}

export class STTRequestError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'STTRequestError';
  }
}

/**
 * Build a multipart/form-data body manually.
 *
 * Obsidian's requestUrl doesn't support FormData directly (it serialises
 * to ArrayBuffer), so we assemble the multipart payload ourselves. This
 * is bog-standard RFC 7578 — a CRLF-delimited body of parts, each with
 * Content-Disposition and (optionally) Content-Type headers.
 */
function buildMultipart(
  fields: Record<string, string>,
  file: { name: string; type: string; data: ArrayBuffer },
): { body: ArrayBuffer; contentType: string } {
  const boundary = '----JP' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];

  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      enc.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${k}"\r\n\r\n` +
          v +
          '\r\n',
      ),
    );
  }

  parts.push(
    enc.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n`,
    ),
  );
  parts.push(file.data);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

  // Concatenate Uint8Arrays into a single ArrayBuffer
  const total = parts.reduce(
    (sum, p) => sum + (p instanceof ArrayBuffer ? p.byteLength : (p as Uint8Array).byteLength),
    0,
  );
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    const view = p instanceof ArrayBuffer ? new Uint8Array(p) : (p as Uint8Array);
    out.set(view, offset);
    offset += view.byteLength;
  }
  return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Transcribe an audio blob via an OpenAI-compatible STT endpoint.
 *
 * Reads endpoint / key / model / language from settings. Throws
 * STTConfigError if mandatory fields are missing, STTRequestError if the
 * HTTP call fails or the response shape is unexpected.
 */
export async function transcribeAudio(
  audio: Blob,
  settings: JournalPartnerSettings,
  opts: STTOptions,
): Promise<string> {
  const endpoint = settings.sttEndpoint.trim().replace(/\/+$/, '');
  const apiKey = settings.sttApiKey.trim();
  const model = settings.sttModel.trim();

  if (!endpoint) throw new STTConfigError('未配置语音 API endpoint');
  if (!apiKey) throw new STTConfigError('未配置语音 API Key');
  if (!model) throw new STTConfigError('未配置语音模型 ID');

  const url = `${endpoint}/audio/transcriptions`;
  const data = await audio.arrayBuffer();
  const fields: Record<string, string> = {
    model,
    response_format: 'json',
  };
  if (settings.sttLanguage && settings.sttLanguage.trim().length > 0) {
    fields.language = settings.sttLanguage.trim();
  }

  const { body, contentType } = buildMultipart(fields, {
    name: `recording.${opts.ext || 'webm'}`,
    type: opts.mimeType || 'audio/webm',
    data,
  });

  let response;
  try {
    response = await requestUrl({
      url,
      method: 'POST',
      contentType,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      throw: false,
    });
  } catch (err) {
    throw new STTRequestError(
      `语音识别请求失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    const snippet = (response.text ?? '').slice(0, 200);
    throw new STTRequestError(
      `语音识别失败（HTTP ${response.status}）：${snippet}`,
      response.status,
    );
  }

  // Most providers return { text: "..." }; some return { results: [...] }
  // (火山). Handle both.
  let payload: unknown;
  try {
    payload = response.json;
  } catch {
    throw new STTRequestError(`无法解析响应：${(response.text ?? '').slice(0, 200)}`);
  }

  const text = extractText(payload);
  if (text === null) {
    throw new STTRequestError(
      `响应中未找到识别文本：${JSON.stringify(payload).slice(0, 200)}`,
    );
  }
  return text.trim();
}

/** Best-effort extraction of the recognised text from a response payload. */
function extractText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  // OpenAI / 火山 兼容接口 / Aliyun 兼容模式
  if (typeof obj.text === 'string') return obj.text;
  // 部分火山原生格式 — { result: { text: "..." } }
  if (obj.result && typeof obj.result === 'object') {
    const t = (obj.result as Record<string, unknown>).text;
    if (typeof t === 'string') return t;
  }
  // 部分供应商 — { data: { text: "..." } }
  if (obj.data && typeof obj.data === 'object') {
    const t = (obj.data as Record<string, unknown>).text;
    if (typeof t === 'string') return t;
  }
  return null;
}
