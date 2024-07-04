import axios from "axios";
import * as ws from "websocket";
import fs from "fs";
import crypto from "crypto";
import upath from "upath";
import ffmpeg, { FfmpegCommand } from "fluent-ffmpeg";
import delay from "delay";

import { Readable as ReadableStream } from "stream";
import Kasumi from "kasumi.js";

export default class Koice {
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
        this.client = client;
        this.targetChannelId = targetChannelId;
        if (binary) this.ffPath = binary;
        ffmpeg.setFfmpegPath(this.ffPath);
    }
    static async create(
        client: Kasumi<any>,
        targetChannelId: string,
        options?: {
            inputCodec?: string;
            inputBitrate?: number;
            inputChannels?: number;
            inputFrequency?: number;
        },
        binary?: string
    ): Promise<Koice | null> {
        const self = new Koice(client, targetChannelId, binary);
        if (await self.startStream(options)) return self;
        else return null;
    }
    /**
     * Start streaming audio in the voice chat
     * @param stream readable stream or path to the audio file
     * @param binary path to ffmpeg binary
     */
    private async startStream(options?: {
        inputCodec?: string;
        inputBitrate?: number;
        inputChannels?: number;
        inputFrequency?: number;
        forceRealSpeed?: boolean;
    }): Promise<boolean> {
        const { data, err } = await this.client.API.voice.join(
            this.targetChannelId,
            {}
        );
        if (err) return false;

        this.ffmpeg = ffmpeg();
        if (options?.inputCodec) this.ffmpeg.audioCodec(options.inputCodec);
        if (options?.inputBitrate)
            this.ffmpeg.audioBitrate(options.inputBitrate);
        if (options?.inputChannels)
            this.ffmpeg.audioChannels(options.inputChannels);
        if (options?.inputFrequency)
            this.ffmpeg.audioFrequency(options.inputFrequency);
        this.ffmpeg.input(this.stream).outputOption(["-map 0:a:0"]);
        if (options?.forceRealSpeed) this.ffmpeg.withNativeFramerate();
        this.ffmpeg
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
                this.close();
            })
            .on("end", (e) => {
                this.close();
            });
        return true;
    }
    async close(): Promise<void> {
        if (this.ffmpeg) {
            this.ffmpeg.kill("SIGKILL");
            delete this.ffmpeg;
        }
        if (!this.isClose) {
            this.isClose = true;
            await this.client.API.voice.leave(this.targetChannelId);
            this.onclose();
        }
    }
    public onclose: () => void = () => {};
}
