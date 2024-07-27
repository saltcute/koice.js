import ffmpeg, { FfmpegCommand } from "fluent-ffmpeg";

import { Readable as ReadableStream } from "stream";
import Kasumi, { SystemMessageEvent } from "kasumi.js";
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

export interface IStreamOptions {
    rtcpMux?: boolean;
    password?: string;
    inputCodec?: string;
    forceRealSpeed?: boolean;
    bitrateFactor?: number;
}

export interface IUserLeaveVoiceChannelEventExtra {
    type: "exited_channel";
    body: {
        user_id: string;
        channel_id: string;
        exited_at: number;
    };
}

export class Koice extends EventEmitter2 {
    private client: Kasumi;
    private targetChannelId: string;

    private stream: ReadableStream = new ReadableStream({
        read() {},
    });
    private fileHead?: any;
    push(chunk: any) {
        if (!this.fileHead) this.fileHead = chunk;
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

        this.client.on("event.system", this.disconnectionHandler);
        this.on("close", this.onclose);
    }
    private streamOptions?: IStreamOptions;
    public setStreamOptions(options?: IStreamOptions) {
        this.streamOptions = options;
    }
    /**
     * Start streaming audio in the voice chat
     * @param targetChannelId voice channel to stream to
     * @param binary path to ffmpeg binary
     */
    static async create(
        client: Kasumi<any>,
        targetChannelId: string,
        options?: IStreamOptions,
        binary?: string
    ): Promise<Koice | null> {
        const self = new Koice(client, targetChannelId, binary);
        self.setStreamOptions(options);
        if (await self.startStream()) return self;
        else return null;
    }
    private async startStream(): Promise<boolean> {
        this.isClose = false;

        const { data, err } = await this.client.API.voice.join(
            this.targetChannelId,
            {
                password: this.streamOptions?.password,
                rtcpMux: this.streamOptions?.rtcpMux,
            }
        );
        if (err) return false;

        this.ffmpeg = ffmpeg();
        this.ffmpeg.input(this.stream);
        if (this.streamOptions?.inputCodec)
            this.ffmpeg.inputFormat(this.streamOptions.inputCodec);
        if (this.streamOptions?.forceRealSpeed)
            this.ffmpeg.withNativeFramerate();
        this.ffmpeg
            .outputOption(["-map 0:a:0"])
            .audioCodec("libopus")
            .audioBitrate(
                `${Math.floor((data.bitrate / 1000) * (this.streamOptions?.bitrateFactor || 1))}k`
            )
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
        if (this.fileHead) this.push(this.fileHead);
        return true;
    }
    private disconnectionHandler = async (event: SystemMessageEvent) => {
        if (event.rawEvent.extra.type == "exited_channel") {
            const extra: IUserLeaveVoiceChannelEventExtra =
                event.rawEvent.extra;
            if (extra.body.user_id == this.client.me.userId) {
                return this.startStream();
            }
        }
        return false;
    };
    async close(reason?: any): Promise<void> {
        if (this.ffmpeg) {
            this.ffmpeg.kill("SIGKILL");
            delete this.ffmpeg;
        }
        if (!this.isClose) {
            this.client.off("event.system", this.disconnectionHandler);
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
