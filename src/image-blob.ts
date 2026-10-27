import { requestUrl, TFile, type Vault } from 'obsidian';

export interface PreviewImageSource { src: string; path?: string }
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
};

/** Vault bytes stay local; only HTTP(S) images use Obsidian's network transport. */
export async function readPreviewImage(vault: Pick<Vault, 'getAbstractFileByPath' | 'readBinary'>, image: PreviewImageSource): Promise<Blob> {
  if (image.path) {
    const file = vault.getAbstractFileByPath(image.path);
    if (!(file instanceof TFile)) throw new Error(`Image file not found: ${image.path}`);
    return new Blob([await vault.readBinary(file)], { type: IMAGE_MIME[file.extension.toLowerCase()] ?? '' });
  }
  if (/^https?:\/\//i.test(image.src)) {
    const response = await requestUrl({ url: image.src });
    const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
    return new Blob([response.arrayBuffer], { type: contentType?.split(';')[0] ?? '' });
  }
  // Browser-owned blob/data URLs and Obsidian local resources are not network requests.
  return new Promise<Blob>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', image.src);
    request.responseType = 'blob';
    request.onload = () => {
      const blob: unknown = request.response;
      if ((request.status === 0 || (request.status >= 200 && request.status < 300)) && blob instanceof Blob) resolve(blob);
      else reject(new Error(`Image read failed: ${request.status}`));
    };
    request.onerror = () => reject(new Error('Image read failed'));
    request.send();
  });
}
