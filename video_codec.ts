import './wasm_exec.js'
/* eslint-disable no-restricted-globals */

function toUint8Array(source: BufferSource): Uint8Array {
    if (source instanceof Uint8Array) {
        return source
    } else if (source instanceof ArrayBuffer) {
        return new Uint8Array(source)
    } else {
        return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    }
}
type CodecParseType = {
    "error": string
    "data"?: {
        "codec": string
        "description": Uint8Array
    }
}
export class VideoCodec{
    private wasm: WebAssembly.Instance = null
    private readonly go = new (self as any).Go()
    private readonly pendingResolves: ((wasm: WebAssembly.Instance) => void)[] = []
    protected done = false

    public constructor() {
        let wasmUrl = "./main.wasm"
        // @ts-ignore
        WebAssembly.instantiateStreaming(fetch(wasmUrl), this.go.importObject).then((obj) => {
            this.wasm = obj.instance;
            this.go.run(this.wasm);
        }).finally(() => {
            this.init()
        });
           
    }

    protected init() {
        this.done = true
        this.pendingResolves.forEach((resolve) => {
            resolve(this.wasm)
        })
    }

    protected async getWasm(): Promise<WebAssembly.Instance> {
        if (this.done) return this.wasm
        return new Promise((resolve, reject) => {
            this.pendingResolves.push(resolve)
        })
    }

    public async parseCodec(sps: BufferSource, pps: BufferSource, vps?: BufferSource): Promise<CodecParseType> {
        let result: CodecParseType = null
        const wasm = await this.getWasm()
        if (wasm) {
            if (vps) {
                result = (self as any).VideoCodecParseH265(toUint8Array(vps), toUint8Array(sps), toUint8Array(pps))
            } else {
                result = (self as any).VideoCodecParseH264(toUint8Array(sps), toUint8Array(pps))
            }
            if (result) {
            } else {
                result = {
                    "error": "empty result",
                    "data": null
                }
            }
        } else {
            result = {
                "error": "null wasm",
                "data": null
            }
        }
        return result
    }
}

export const parseCodecInst = new VideoCodec()
