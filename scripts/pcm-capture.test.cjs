const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const filename = path.resolve(__dirname, '../src/pcm-capture.ts');
const code = buildSync({ entryPoints: [filename], bundle: true, write: false, format: 'cjs', platform: 'node' }).outputFiles[0].text;
const loaded = new Module(filename, module);
loaded._compile(code, filename);
const { createPcmCapture, PCM_PROCESSOR_SOURCE } = loaded.exports;

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function withDevices(run, addModule = async () => {}) {
  const previous = { node: global.AudioWorkletNode, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const effects = { nodes: [], urls: [], revoked: [], sourceConnections: [], sourceDisconnections: [] };
  URL.createObjectURL = blob => { effects.urls.push(blob); return `blob:test-${effects.urls.length}`; };
  URL.revokeObjectURL = url => effects.revoked.push(url);
  global.AudioWorkletNode = class {
    constructor(context, name, options) {
      Object.assign(this, { context, name, options, outputs: [], disconnects: 0, portCloses: 0 });
      this.port = { onmessage: null, close: () => this.portCloses++ };
      effects.nodes.push(this);
    }
    connect(output) { this.outputs.push(output); }
    disconnect() { this.disconnects++; }
  };
  const context = { state: 'running', destination: {}, audioWorklet: { addModule } };
  const source = { connect: node => effects.sourceConnections.push(node), disconnect: node => effects.sourceDisconnections.push(node) };
  try { await run({ context, source, effects }); }
  finally { global.AudioWorkletNode = previous.node; URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke; }
}

test('processor transfers an independent input copy and never writes microphone audio to output', () => {
  const posted = []; let Processor;
  vm.runInNewContext(PCM_PROCESSOR_SOURCE, {
    Float32Array,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (...args) => posted.push(args) }; } },
    registerProcessor(name, ctor) { assert.equal(name, 'spark-memo-pcm'); Processor = ctor; },
  });
  const processor = new Processor();
  const input = new Float32Array([0.25, -0.5, 0.75]);
  const output = new Float32Array(3);
  assert.equal(processor.process([[input]], [[output]]), true);
  assert.deepEqual(posted[0][0], input);
  assert.notEqual(posted[0][0].buffer, input.buffer);
  assert.equal(posted[0][1][0], posted[0][0].buffer);
  assert.deepEqual(output, new Float32Array(3));
  assert.equal(processor.process([], [[output]]), true);
  assert.equal(posted.length, 1);
});

test('capture preserves 4096-sample frames, flushes its tail once and disconnects idempotently', async () => {
  await withDevices(async ({ context, source, effects }) => {
    const frames = [];
    const capture = await createPcmCapture(context, source, frame => frames.push(frame));
    const node = effects.nodes[0];
    assert.equal(node.name, 'spark-memo-pcm');
    assert.deepEqual(node.outputs, [context.destination]);
    assert.equal(await effects.urls[0].text(), PCM_PROCESSOR_SOURCE);
    assert.deepEqual(effects.revoked, ['blob:test-1']);
    const input = Float32Array.from({ length: 9000 }, (_, i) => i / 10000);
    for (let i = 0; i < input.length; i += 128) node.port.onmessage({ data: input.slice(i, i + 128) });
    node.port.onmessage({ data: 'invalid message' });
    assert.deepEqual(frames.map(frame => frame.length), [4096, 4096]);
    capture.flush(); capture.flush();
    assert.deepEqual(frames.map(frame => frame.length), [4096, 4096, 808]);
    assert.deepEqual(Float32Array.from(frames.flatMap(frame => [...frame])), input);
    const lateMessage = node.port.onmessage;
    capture.dispose(); capture.dispose(); capture.flush();
    lateMessage({ data: new Float32Array(4096) });
    assert.equal(frames.length, 3);
    assert.deepEqual(effects.sourceDisconnections, [node]);
    assert.equal(node.disconnects, 1); assert.equal(node.portCloses, 1);
    assert.equal(node.port.onmessage, null);
  });
});

test('module failure revokes its temporary URL and never connects an audio node', async () => {
  await withDevices(async ({ context, source, effects }) => {
    await assert.rejects(createPcmCapture(context, source, () => {}), /module blocked/);
    assert.deepEqual(effects.revoked, ['blob:test-1']);
    assert.equal(effects.nodes.length, 0);
    assert.equal(effects.sourceConnections.length, 0);
  }, async () => { throw Error('module blocked'); });
});

test('closing the audio context while the module loads prevents a late audio node', async () => {
  const loading = deferred();
  await withDevices(async ({ context, source, effects }) => {
    const starting = createPcmCapture(context, source, () => {});
    context.state = 'closed'; loading.resolve();
    await assert.rejects(starting, /context is closed/);
    assert.equal(effects.nodes.length, 0);
    assert.deepEqual(effects.revoked, ['blob:test-1']);
  }, () => loading.promise);
});


test('an unavailable AudioWorklet fails explicitly without allocating a module URL', async () => {
  await withDevices(async ({ context, source, effects }) => {
    context.audioWorklet = undefined;
    await assert.rejects(createPcmCapture(context, source, () => {}), /AudioWorklet is unavailable/);
    assert.equal(effects.urls.length, 0);
    assert.equal(effects.nodes.length, 0);
  });
});
