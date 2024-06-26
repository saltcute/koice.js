import axios from 'axios';
import * as ws from 'websocket';
import fs from 'fs';
import crypto from 'crypto';
import upath from 'upath';
import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import delay from 'delay';

import { Readable as ReadableStream } from "stream";

export default class Koice {
    private token: string;

    private rtpURL: string = "";
    private haveURL: boolean = false;

    private ffPath: string = "ffmpeg";

    private _ffStream?: FfmpegCommand;
    get ffStream() {
        return this._ffStream;
    }
    private set ffStream(payload: FfmpegCommand | undefined) {
        this._ffStream = payload;
    }
    private isStreaming: boolean = false;

    haveWSConnection: boolean = false;
    private wsClient?: ws.client;
    private wsConnection?: ws.connection;

    _isClose: boolean = false;
    get isClose() {
        return this._isClose;
    }
    private set isClose(payload: boolean) {
        this._isClose = payload;
    }
    // channelId: string;
    constructor(tk: string, binary?: string) {
        this.token = tk;
        if (binary) this.ffPath = binary;
        ffmpeg.setFfmpegPath(this.ffPath);
    }
    async getrtpURL(): Promise<string> {
        while (!this.haveURL) {
            await delay(100);
        }
        return this.rtpURL;
    }
    async getGateway(channelId: string): Promise<string> {
        const res = await axios({
            url: "https://www.kookapp.cn/api/v3/gateway/voice",
            method: "GET",
            params: {
                channel_id: channelId
            },
            headers: {
                'Authorization': `Bot ${this.token}`
            }
        })
        // console.log(res);
        return res.data.data.gateway_url;
    }
    /**
     * Start streaming audio in the voice chat
     * @param stream readable stream or path to the audio file
     * @param binary path to ffmpeg binary
     */
    async startStream(stream: ReadableStream | string, options?: {
        inputCodec?: string,
        inputBitrate?: number,
        inputChannels?: number,
        inputFrequency?: number
    }): Promise<void> {
        if (this.isStreaming) {
            throw 'Another stream is still active';
        }
        this.isStreaming = true;
        // console.log("===Start Playing===");
        while (!this.haveURL) {
            await delay(100);
        }
        this.ffStream = ffmpeg();
        if (options?.inputCodec) this.ffStream.audioCodec(options.inputCodec);
        if (options?.inputBitrate) this.ffStream.audioBitrate(options.inputBitrate);
        if (options?.inputChannels) this.ffStream.audioChannels(options.inputChannels);
        if (options?.inputFrequency) this.ffStream.audioFrequency(options.inputFrequency);
        this.ffStream
            .input(stream)
            .outputOption([
                '-map 0:a:0'
            ])
            .withNativeFramerate()
            .audioCodec('libopus')
            .audioBitrate('192k')
            .audioChannels(2)
            .audioFrequency(48000)
            .outputFormat('tee')
            .save(`[select=a:f=rtp:ssrc=1357:payload_type=100]${this.rtpURL}`)
            .removeAllListeners('error')
            .removeAllListeners('end')
            .on('error', (e) => {
                this.stop();
            })
            .on('end', (e) => {
                this.stop();
            })
    }
    stopStream() {
        if (this.ffStream) {
            this.ffStream.kill("SIGKILL");
            delete this.ffStream
        }
        this.isStreaming = false;
    }
    async reset() {
        await this.close();
        this.rtpURL = "";
        this.haveURL = false;
        // this.zmqPort = undefined
        this.ffPath = "ffmpeg";
        this.isStreaming = false;
    }
    async connectWebSocket(channelId: string): Promise<boolean> {
        const gateway = await this.getGateway(channelId);
        if (!gateway) {
            await this.close();
            return false;
        }
        const msgJSON = JSON.parse(fs.readFileSync(upath.toUnix(upath.join(__dirname, "msg.json")), { encoding: "utf-8", flag: "r" }));
        var ip: string, port: string, rtcpPort: string;
        // console.log(gateway);
        this.wsClient = new ws.client();
        this.wsClient.on('connectFailed', (err) => {
            this.haveWSConnection = false;
            throw err;
        })
        this.wsClient.on('connect', (connection) => {
            this.haveWSConnection = true;
            this.wsConnection = connection;
            // console.log("WebSocket connected");
            connection.send(JSON.stringify(msgJSON[1]));
            var current: number = 1;
            setInterval(() => {
                connection.ping("");
            }, 30 * 1000)
            connection.on('message', (message) => {
                if (message.type == "utf8") {
                    // console.log(message);
                    const data = JSON.parse(message.utf8Data);
                    // console.log(`${current}: `);
                    // console.dir(data, { depth: null });
                    // console.log("");
                    if (current == 1) {
                        msgJSON[2].id = crypto.randomInt(1000000, 10000000);
                        // msgJSON[2].data.displayName = "PlayTest#1";
                        connection.send(JSON.stringify(msgJSON[2]));
                        current = 2;
                    } else if (current == 2) {
                        msgJSON[3].id = crypto.randomInt(1000000, 10000000);
                        connection.send(JSON.stringify(msgJSON[3]));
                        current = 3;
                    } else if (current == 3) {
                        const transportId = data.data.id;
                        ip = data.data.ip;
                        port = data.data.port;
                        rtcpPort = data.data.rtcpPort;
                        msgJSON[4].id = crypto.randomInt(1000000, 10000000);
                        msgJSON[4].data.transportId = transportId;
                        connection.send(JSON.stringify(msgJSON[4]));
                        current = 4;
                    } else if (current == 4) {
                        this.rtpURL = `rtp://${ip}:${port}?rtcpport=${rtcpPort}`;
                        this.haveURL = true;
                        current = 5;
                    }
                    else {
                        if (data.notification && data.method && data.method == "disconnect") {
                            this.disconnectWebSocket();
                        }
                    }
                }
            });
            connection.on('close', () => {
                this.haveWSConnection = false;
                this.close();
            })
            connection.on('error', (err) => {
                this.haveWSConnection = false;
                this.close();
                throw err;
            })
        })
        this.wsClient.on('connectFailed', (err) => {
            throw err;
        })
        this.wsClient.connect(gateway);
        return true;
    }
    async disconnectWebSocket(): Promise<void> {
        var closed = false;
        if (this.wsConnection) {
            this.wsConnection.removeAllListeners();
            this.wsConnection.on('close', () => {
                this.wsConnection = undefined;
                closed = true;
            })
            this.wsConnection.close();
            while (!closed) {
                await delay(100);
            }
        }
        if (this.wsClient) {
            this.wsClient.removeAllListeners();
            this.wsClient = undefined;
        }
        this.haveWSConnection = false;
        this.haveURL = false;
        this.rtpURL = "";
    }
    kill() {
        return this.stopStream();
    }
    async stop() {
        if (!this.isClose) {
            this.isClose = true;
            await this.disconnectWebSocket();
            this.onclose();
        }
    }
    async close(): Promise<void> {
        this.kill();
        await this.stop();
    }
    public onclose: () => void = () => { };
}