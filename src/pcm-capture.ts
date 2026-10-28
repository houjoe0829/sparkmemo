/** Audio-thread input is copied to the main thread; outputs stay silent. */
export const PCM_PROCESSOR_SOURCE = `
class SparkMemoPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && input.length > 0) {
      const frame = new Float32Array(input);
      this.port.postMessage(frame, [frame.buffer]);
    }
    return true;
  }
}
registerProcessor('spark-memo-pcm', SparkMemoPcmProcessor);
`;

export interface PcmCapture {
  /** Deliver the buffered tail before flushing the existing VAD segment. */
  flush(): void;
  dispose(): void;
}

/** Keep the existing 4096-sample VAD cadence without deprecated audio APIs. */
export async function createPcmCapture(
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  onFrame: (frame: Float32Array) => void,
): Promise<PcmCapture> {
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    throw new Error('AudioWorklet is unavailable');
  }
  const moduleUrl = URL.createObjectURL(new Blob([PCM_PROCESSOR_SOURCE], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  if (context.state === 'closed') throw new Error('Recording audio context is closed');
  const node = new AudioWorkletNode(context, 'spark-memo-pcm', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  });
  let disposed = false;
  let buffer = new Float32Array(4096);
  let used = 0;
  node.port.onmessage = (message: MessageEvent<unknown>) => {
    if (disposed || !(message.data instanceof Float32Array)) return;
    const frame = message.data;
    let offset = 0;
    while (offset < frame.length) {
      const count = Math.min(buffer.length - used, frame.length - offset);
      buffer.set(frame.subarray(offset, offset + count), used);
      used += count;
      offset += count;
      if (used === buffer.length) {
        const complete = buffer;
        buffer = new Float32Array(4096);
        used = 0;
        onFrame(complete);
      }
    }
  };
  source.connect(node);
  // A destination connection keeps processing active. The processor never writes
  // to its output, so microphone audio cannot be played through the speakers.
  node.connect(context.destination);
  return {
    flush() {
      if (disposed || used === 0) return;
      const tail = buffer.slice(0, used);
      used = 0;
      onFrame(tail);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      source.disconnect(node);
      node.disconnect();
      node.port.onmessage = null;
      node.port.close();
    },
  };
}
