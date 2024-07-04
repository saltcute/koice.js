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

    private streamUri?: string;
    private targetBirtate?: number;
    private targetChannelId?: string;

    private stream: ReadableStream = new ReadableStream({
        read() {},
    });
    push(chunk: Buffer) {
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
        token: string,
        targetChannelId: string,
        binary?: string
    ) {
        this.client = new Kasumi({
            token,
            type: "websocket",
        });
        this.targetChannelId = targetChannelId;
        if (binary) this.ffPath = binary;
        ffmpeg.setFfmpegPath(this.ffPath);
    }
    async create(
        token: string,
        targetChannelId: string,
        binary?: string
    ): Promise<Koice> {
        const self = new Koice(token, targetChannelId, binary);
        await self.startStream(targetChannelId);
        return self;
    }
    /**
     * Start streaming audio in the voice chat
     * @param stream readable stream or path to the audio file
     * @param binary path to ffmpeg binary
     */
    async startStream(
        channelId: string,
        options?: {
            inputCodec?: string;
            inputBitrate?: number;
            inputChannels?: number;
            inputFrequency?: number;
        }
    ): Promise<boolean> {
        const { data, err } = await this.client.API.voice.join(channelId, {});
        if (err) return false;
        const streamUri = `[select=a:f=rtp:srrc=${data.audio_ssrc}:payload_type=${data.audio_pt}]rtp://${data.ip}:${data.port}?rtcpport=${data.rtcp_port}`;
        const bitrate = data.bitrate;

        this.ffmpeg = ffmpeg();
        if (options?.inputCodec) this.ffmpeg.audioCodec(options.inputCodec);
        if (options?.inputBitrate)
            this.ffmpeg.audioBitrate(options.inputBitrate);
        if (options?.inputChannels)
            this.ffmpeg.audioChannels(options.inputChannels);
        if (options?.inputFrequency)
            this.ffmpeg.audioFrequency(options.inputFrequency);
        this.ffmpeg
            .input(this.stream)
            .outputOption(["-map 0:a:0"])
            .withNativeFramerate()
            .audioCodec("libopus")
            .audioBitrate(data.bitrate)
            .audioChannels(2)
            .audioFrequency(48000)
            .outputFormat("tee")
            .save(streamUri)
            .removeAllListeners("error")
            .removeAllListeners("end")
            .on("error", () => {
                this.stop();
            })
            .on("end", () => {
                this.stop();
            });
        return true;
    }
    stopStream() {
        if (this.ffmpeg) {
            this.ffmpeg.kill("SIGKILL");
            delete this.ffmpeg;
        }
    }
    async reset() {
        await this.close();
        this.ffPath = "ffmpeg";
    }
    kill() {
        return this.stopStream();
    }
    async stop() {
        if (!this.isClose) {
            this.isClose = true;
            this.onclose();
        }
    }
    async close(): Promise<void> {
        this.kill();
        await this.stop();
    }
    public onclose: () => void = () => {};
}
