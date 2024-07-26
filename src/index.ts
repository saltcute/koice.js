import ffmpeg, { FfmpegCommand } from "fluent-ffmpeg";

import { Readable as ReadableStream } from "stream";
import Kasumi from "kasumi.js";
import EventEmitter2 from "eventemitter2";

export interface RawEmisions {
    close: (event?: any) => void;
}

export interface Koice extends EventEmitter2 {
    on<T extends keyof RawEmisions>(event: T, listener: RawEmisions[T]): this;
    emit<T extends keyof RawEmisions>(
        event: T,
        ...args: Parameters<RawEmisions[T]>
    ): boolean;
}

export class Koice extends EventEmitter2 {
    private client: Kasumi;
    private targetChannelId: string;

    private streamUri?: string;
    private targetBirtate?: number;

    private stream: ReadableStream = new ReadableStream({
        read() {},
    });
    push(chunk: any) {
        this.stream.push(chunk);
    }

    private ffPath: string = "ffmpeg";

    private _ffmpeg?: FfmpegCommand;
    get ffmpeg() {
        return this._ffmpeg;
    }
    private set ffmpeg(payload: FfmpegCommand | undefined) {
        this._ffmpeg = payload;
    }

    _isClose: boolean = false;
    get isClose() {
        return this._isClose;
    }
    private set isClose(payload: boolean) {
        this._isClose = payload;
    }
    private constructor(
        client: Kasumi<any>,
        targetChannelId: string,
        binary?: string
    ) {
        super();
        this.client = client;
        this.targetChannelId = targetChannelId;
        if (binary) this.ffPath = binary;
        ffmpeg.setFfmpegPath(this.ffPath);

        this.on("close", this.onclose);
    }
    /**
     * Start streaming audio in the voice chat
     * @param targetChannelId voice channel to stream to
     * @param binary path to ffmpeg binary
     */
    static async create(
        client: Kasumi<any>,
        targetChannelId: string,
        options?: {
            inputCodec?: string;
        },
        binary?: string
    ): Promise<Koice | null> {
        const self = new Koice(client, targetChannelId, binary);
        if (await self.startStream(options)) return self;
        else return null;
    }
    private async startStream(options?: {
        inputCodec?: string;
        forceRealSpeed?: boolean;
    }): Promise<boolean> {
        this.isClose = false;

        const { data, err } = await this.client.API.voice.join(
            this.targetChannelId,
            {}
        );
        if (err) return false;

        this.ffmpeg = ffmpeg();
        this.ffmpeg.input(this.stream);
        // if (options?.inputCodec)
        //     this.ffmpeg.addInputOptions(`-acodec ${options.inputCodec}`);
        if (options?.forceRealSpeed) this.ffmpeg.withNativeFramerate();
        this.ffmpeg
            .outputOption(["-map 0:a:0"])
            .audioCodec("libopus")
            .audioBitrate(`${Math.floor(data.bitrate / 1000)}k`)
            .audioChannels(2)
            .audioFrequency(48000)
            .outputFormat("tee")
            .save(
                `[select=a:f=rtp:ssrc=${data.audio_ssrc}:payload_type=${data.audio_pt}]rtp://${data.ip}:${data.port}?rtcpport=${data.rtcp_port}`
            )
            .removeAllListeners("error")
            .removeAllListeners("end")
            .on("error", (e) => {
                this.close(e);
            })
            .on("end", (e) => {
                this.close(e);
            });
        return true;
    }
    async close(reason?: any): Promise<void> {
        if (this.ffmpeg) {
            this.ffmpeg.kill("SIGKILL");
            delete this.ffmpeg;
        }
        if (!this.isClose) {
            await this.client.API.voice.leave(this.targetChannelId);
            this.isClose = true;
            this.emit("close", reason);
        }
    }
    /**
     * @deprecated
     */
    public onclose: () => void = () => {};
}

export default Koice;
