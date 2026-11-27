// A WebGPU device for Node tests: buffers are ArrayBuffers, queue and encoder
// commands run in submission order, and compute dispatches call `run` with
// the bound bytes. It records usages, bind groups, dispatches and maps.
// Not part of the package (`files` ships src/**/*.js only).

export const USAGE = {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
};

/** Installs GPUBufferUsage and GPUMapMode for the duration of `body`. */
export async function withGPUGlobals(body) {
  globalThis.GPUBufferUsage = USAGE;
  globalThis.GPUMapMode = { READ: 1, WRITE: 2 };
  try {
    return await body();
  } finally {
    delete globalThis.GPUBufferUsage;
    delete globalThis.GPUMapMode;
  }
}

export function fakeDevice({ run = () => {}, limits = {} } = {}) {
  const log = [];
  const buffers = [];

  function view(data, dataOffset = 0, size) {
    if (ArrayBuffer.isView(data)) {
      const unit = data.BYTES_PER_ELEMENT ?? 1;
      const length = size === undefined ? data.length - dataOffset : size;
      return new Uint8Array(data.buffer, data.byteOffset + dataOffset * unit, length * unit);
    }
    const length = size === undefined ? data.byteLength - dataOffset : size;
    return new Uint8Array(data, dataOffset, length);
  }

  function checkAlive(buffer, what) {
    if (buffer.destroyed) {
      throw new Error(`${what}: buffer ${buffer.label ?? ""} is destroyed`);
    }
  }

  const device = {
    log,
    buffers,
    limits,
    features: new Set(),
    lost: new Promise(() => {}),
    createBuffer({ label, size, usage, mappedAtCreation = false }) {
      if (size % 4 !== 0) {
        throw new Error(`createBuffer: size ${size} is not a multiple of 4`);
      }
      const bytes = new ArrayBuffer(size);
      const buffer = {
        label,
        size,
        usage,
        bytes,
        destroyed: false,
        getMappedRange: () => bytes,
        unmap() {},
        async mapAsync() {
          log.push(["map", label]);
        },
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      log.push(["createBuffer", label, size, usage, mappedAtCreation]);
      return buffer;
    },
    createShaderModule: ({ code }) => ({
      code,
      getCompilationInfo: async () => ({ messages: [] }),
    }),
    createComputePipelineAsync: async ({ compute }) => ({
      entryPoint: compute.entryPoint,
      getBindGroupLayout: () => compute.entryPoint,
    }),
    createBindGroup({ layout, entries }) {
      log.push(["bindGroup", layout, entries.map((entry) => entry.binding)]);
      return { entries: entries.map((entry) => [entry.binding, entry.resource.buffer]) };
    },
    createCommandEncoder() {
      const commands = [];
      return {
        beginComputePass() {
          let pipeline;
          let group;
          return {
            setPipeline(value) {
              pipeline = value;
            },
            setBindGroup(_, value) {
              group = value;
            },
            dispatchWorkgroups(x, y = 1, z = 1) {
              const entryPoint = pipeline.entryPoint;
              const bound = group;
              log.push(["dispatch", entryPoint, x, y, z]);
              commands.push(() => {
                const bytes = {};
                for (const [binding, buffer] of bound.entries) {
                  checkAlive(buffer, entryPoint);
                  bytes[binding] = buffer.bytes;
                }
                run(entryPoint, bytes, x, y);
              });
            },
            end() {},
          };
        },
        copyBufferToBuffer(source, from, target, to, size) {
          if (source === target) {
            throw new Error("copyBufferToBuffer: source and target are the same buffer");
          }
          if (
            from % 4 ||
            to % 4 ||
            size % 4 ||
            from + size > source.size ||
            to + size > target.size
          ) {
            throw new Error(`copyBufferToBuffer: bad range ${from}->${to} (${size})`);
          }
          log.push(["copy", source.label, target.label, size]);
          commands.push(() => {
            checkAlive(source, "copy");
            checkAlive(target, "copy");
            new Uint8Array(target.bytes, to, size).set(new Uint8Array(source.bytes, from, size));
          });
        },
        clearBuffer(buffer, offset = 0, size = buffer.size - offset) {
          log.push(["clear", buffer.label, offset, size]);
          commands.push(() => new Uint8Array(buffer.bytes, offset, size).fill(0));
        },
        finish: () => commands,
      };
    },
    pushErrorScope() {},
    popErrorScope: async () => null,
    queue: {
      writeBuffer(buffer, offset, data, dataOffset, size) {
        checkAlive(buffer, "writeBuffer");
        const bytes = view(data, dataOffset, size);
        if (offset % 4 || bytes.byteLength % 4 || offset + bytes.byteLength > buffer.size) {
          throw new Error(
            `writeBuffer: bad range ${offset} (${bytes.byteLength}) in ${buffer.size}`,
          );
        }
        log.push(["write", buffer.label, offset, bytes.byteLength]);
        new Uint8Array(buffer.bytes, offset, bytes.byteLength).set(bytes);
      },
      submit(commandBuffers) {
        log.push(["submit"]);
        for (const commands of commandBuffers) {
          commands.forEach((command) => command());
        }
      },
      onSubmittedWorkDone: async () => {},
    },
  };
  return device;
}
