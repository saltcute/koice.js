import ffmpeg, { FfmpegCommand } from "fluent-ffmpeg";

import { Readable as ReadableStream } from "stream";
import Kasumi, { SystemMessageEvent } from "kasumi.js";
import EventEmitter2 from "eventemitter2";
import Logger from "bunyan";
import schedule from "node-schedule";

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
    private readonly TARGET_CHANNEL_ID: string;
    private logger: Logger;

    private stream: ReadableStream = new ReadableStream({
        read() {},
    });
    private fileHead?: any;

    /**
     * Set file header so that ffmpeg understand the format of the audio data.
     *
     * @param chunk Any buffer-like file header data.
     */
    public setFileHead(chunk: any) {
        this.fileHead = chunk;
        this.stream.push(chunk);
    }

    /**
     * Push audio data to koice.
     *
     * @param chunk Any buffer-like audio data.
     */
    public push(chunk: any) {
        if (!this.fileHead) this.setFileHead(chunk);
        else this.stream.push(chunk);
    }

    private ffPath: string = "ffmpeg";

    private _ffmpeg?: FfmpegCommand;

    /**
     * Get the ffmpeg instance.
     */
    public get ffmpeg() {
        return this._ffmpeg;
    }

    private set ffmpeg(payload: FfmpegCommand | undefined) {
        this._ffmpeg = payload;
    }

    _isClose: boolean = false;

    /**
     * Get whether koice is closed.
     *
     * @returns True if closed.
     */
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
        this.TARGET_CHANNEL_ID = targetChannelId;
        if (binary) this.ffPath = binary;
        ffmpeg.setFfmpegPath(this.ffPath);

        this.logger = this.client.getLogger("koice");

        this.on("close", this.onclose);
    }
    private streamOptions?: IStreamOptions;

    /**
     * Set koice stream options.
     *
     * @param options Koice stream options.
     */
    public setStreamOptions(options?: IStreamOptions) {
        this.streamOptions = options;
        if (this.streamOptions && this.streamOptions.rtcpMux == undefined) {
            this.streamOptions.rtcpMux = true;
        }
    }

    /**
     * Start streaming audio in the voice chat
     *
     * @param client Kasumi.js instance.
     * @param targetChannelId The voice channel to stream to.
     * @param options Koice stream options.
     * @param binary The path to a specific ffmpeg binary to use.
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
    private keepAliveSchedule?: schedule.Job;
    private keepAliveTask() {
        if (this.keepAliveSchedule) schedule.cancelJob(this.keepAliveSchedule);
        this.keepAliveSchedule = schedule.scheduleJob(
            "*/45 * * * * *",
            async () => {
                await this.client.API.voice.keepAlive(this.TARGET_CHANNEL_ID);
            }
        );
    }
    private async startStream(): Promise<boolean> {
        this.client.on("event.system", this.disconnectionHandler);
        this.isClose = false;

        const { data, err } = await this.client.API.voice.join(
            this.TARGET_CHANNEL_ID,
            {
                password: this.streamOptions?.password,
                rtcpMux: this.streamOptions?.rtcpMux,
            }
        );
        this.keepAliveTask();
        if (err) return false;

        this.ffmpeg = ffmpeg().addOption("-hide_banner", "-loglevel fatal");
        this.stream = new ReadableStream({
            read() {},
        });
        this.logger.debug(
            `started streaming with${this.fileHead ? "" : "out"} file head`
        );
        if (this.fileHead) this.push(this.fileHead);
        this.ffmpeg.input(this.stream);
        if (this.streamOptions?.inputCodec)
            this.ffmpeg.inputFormat(this.streamOptions.inputCodec);
        if (this.streamOptions?.forceRealSpeed)
            this.ffmpeg.withNativeFramerate();
        const bitrateString = `${Math.floor((data.bitrate / 1000) * (this.streamOptions?.bitrateFactor || 1))}k`;
        this.ffmpeg
            .outputOption([
                "-map 0:a:0",
                "-vbr constrained",
                "-frame_size 960",
                `-maxrate ${bitrateString}`,
            ])
            .audioCodec("libopus")
            .audioBitrate(bitrateString)
            .audioChannels(2)
            .audioFrequency(48000)
            .outputFormat("tee")
            .save(
                `[select=a:f=rtp:ssrc=${data.audio_ssrc}:payload_type=${data.audio_pt}]rtp://${data.ip}:${data.port}${this.streamOptions?.rtcpMux ? "" : `?rtcpport=${data.rtcp_port}`}`
            )
            .removeAllListeners("error")
            .removeAllListeners("end")
            .removeAllListeners("exit")
            .on("exit", () => {
                this.logger.debug("ffmpeg process exited");
            })
            .on("error", (e) => {
                this.retry(e);
            })
            .on("end", (e) => {
                this.retry(e);
            })
            .on("close", (e) => {
                this.retry(e);
            });
        return true;
    }
    private disconnectionHandler = async (event: SystemMessageEvent) => {
        if (event.rawEvent.extra.type == "exited_channel") {
            const extra: IUserLeaveVoiceChannelEventExtra =
                event.rawEvent.extra;
            if (extra.body.user_id == this.client.me.userId) {
                this.retry("Recieved exit voice channel event unexpectedly");
            }
        }
    };
    private async endStream(): Promise<boolean> {
        if (!this.isClose) {
            this.isClose = true;
            if (this.ffmpeg) {
                this.ffmpeg
                    .removeAllListeners("exit")
                    .removeAllListeners("close")
                    .removeAllListeners("error")
                    .removeAllListeners("end")
                    .on("exit", () => {})
                    .on("close", () => {})
                    .on("error", () => {})
                    .on("end", () => {})
                    .kill("SIGKILL");
                delete this.ffmpeg;
            }
            this.client.off("event.system", this.disconnectionHandler);
            await this.client.API.voice.leave(this.TARGET_CHANNEL_ID);
            return true;
        }
        return false;
    }
    private async retry(reason: any) {
        if (await this.endStream()) {
            this.startStream();
        }
    }

    /**
     * Close koice.
     *
     * @param reason The reason to close.
     */
    public async close(reason?: any): Promise<void> {
        if (await this.endStream()) {
            this.emit("close", reason);
        }
    }
    /**
     * @deprecated
     */
    public onclose: () => void = () => {};
}

export default Koice;
